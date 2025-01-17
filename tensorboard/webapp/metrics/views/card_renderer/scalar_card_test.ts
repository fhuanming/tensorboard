/* Copyright 2020 The TensorFlow Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/
import {OverlayContainer} from '@angular/cdk/overlay';
import {ChangeDetectorRef, Component, Input, TemplateRef} from '@angular/core';
import {
  ComponentFixture,
  fakeAsync,
  flush,
  TestBed,
  tick,
} from '@angular/core/testing';
import {MatMenuModule} from '@angular/material/menu';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {By} from '@angular/platform-browser';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {Store} from '@ngrx/store';
import {MockStore, provideMockStore} from '@ngrx/store/testing';
import {of, ReplaySubject} from 'rxjs';

import {State} from '../../../app_state';
import {Run} from '../../../runs/store/runs_types';
import {buildRun} from '../../../runs/store/testing';
import * as selectors from '../../../selectors';
import {MatIconTestingModule} from '../../../testing/mat_icon_module';
import {DataLoadState} from '../../../types/data';
import {RunColorScale} from '../../../types/ui';
import {
  XAxisType as ChartXAxisType,
  YAxisType,
} from '../../../widgets/line_chart/line_chart_types';
import {TooltipSortingMethod} from '../../../widgets/line_chart/polymer_interop_types';
import {Formatter} from '../../../widgets/line_chart_v2/lib/formatter';
import {
  DataSeries,
  DataSeriesMetadataMap,
  RendererType,
  ScaleType,
  TooltipDatum,
} from '../../../widgets/line_chart_v2/types';
import {ResizeDetectorTestingModule} from '../../../widgets/resize_detector_testing_module';
import {TruncatedPathModule} from '../../../widgets/text/truncated_path_module';
import {PluginType} from '../../data_source';
import {
  appStateFromMetricsState,
  buildMetricsState,
  provideMockCardRunToSeriesData,
} from '../../testing';
import {TooltipSort, XAxisType} from '../../types';
import {
  ScalarCardComponent,
  ScalarChartEvalPoint,
  SeriesDataList,
  TooltipColumns,
} from './scalar_card_component';
import {ScalarCardContainer} from './scalar_card_container';
import {
  ScalarCardPoint,
  ScalarCardSeriesMetadata,
  SeriesType,
} from './scalar_card_types';

@Component({
  selector: 'tb-line-chart',
  template: '',
})
class TestableLineChart {
  @Input() colorScale!: RunColorScale;
  @Input() tooltipColumns!: TooltipColumns;
  @Input() seriesDataList!: SeriesDataList;
  @Input() smoothingEnabled!: boolean;
  @Input() ignoreYOutliers!: boolean;
  @Input() smoothingWeight!: number;
  @Input() xAxisType!: ChartXAxisType;
  @Input() yAxisType!: YAxisType;
  @Input() tooltipSortingMethod!: TooltipSortingMethod;
  redraw() {}
  resetDomain() {}
}

@Component({
  selector: 'line-chart',
  template: `
    {{ tooltipData | json }}
    <ng-container
      *ngIf="tooltipTemplate"
      [ngTemplateOutlet]="tooltipTemplate"
      [ngTemplateOutletContext]="{
        data: tooltipDataForTesting,
        cursorLocationInDataCoord: cursorLocForTesting
      }"
    ></ng-container>
  `,
})
class TestableGpuLineChart {
  @Input() customXFormatter?: Formatter;
  @Input() preferredRendererType!: RendererType;
  @Input() seriesData!: DataSeries[];
  @Input() seriesMetadataMap!: DataSeriesMetadataMap;
  @Input() xScaleType!: ScaleType;
  @Input() yScaleType!: ScaleType;
  @Input() ignoreYOutliers!: boolean;
  @Input()
  tooltipTemplate!: TemplateRef<{data: TooltipDatum[]}>;

  // This input does not exist on real line-chart and is devised to make tooltipTemplate
  // testable without using the real implementation.
  @Input() tooltipDataForTesting: TooltipDatum[] = [];
  @Input() cursorLocForTesting: {x: number; y: number} = {x: 0, y: 0};

  constructor(public readonly changeDetectorRef: ChangeDetectorRef) {}
}

describe('scalar card', () => {
  let store: MockStore<State>;
  let selectSpy: jasmine.Spy;
  let overlayContainer: OverlayContainer;
  let resizeTester: ResizeDetectorTestingModule;

  function openOverflowMenu(fixture: ComponentFixture<ScalarCardContainer>) {
    const menuButton = fixture.debugElement.query(
      By.css('[aria-label="More line chart options"]')
    );
    menuButton.nativeElement.click();
    fixture.detectChanges();
  }

  function getMenuButton(buttonAriaLabel: string) {
    const buttons = overlayContainer
      .getContainerElement()
      .querySelectorAll(`[aria-label="${buttonAriaLabel}"]`);
    expect(buttons.length).toBe(1);
    return buttons[0] as HTMLButtonElement;
  }

  function createComponent(
    cardId: string
  ): ComponentFixture<ScalarCardContainer> {
    const fixture = TestBed.createComponent(ScalarCardContainer);
    fixture.componentInstance.cardId = cardId;
    // Let the observables to be subscribed.
    fixture.detectChanges();
    // Flush the debounce on the `seriesDataList$`.
    tick(0);
    // Redraw based on the flushed `seriesDataList$`.
    fixture.detectChanges();

    const scalarCardComponent = fixture.debugElement.query(
      By.directive(ScalarCardComponent)
    );
    const lineChartComponent = fixture.debugElement.query(
      By.directive(TestableLineChart)
    );

    // LineChart is rendered inside *ngIf. Set it only when it is rendered.
    if (lineChartComponent) {
      // HACK: we are using viewChild in ScalarCardComponent and there is
      // no good way to provide a stub implementation. Manually set what
      // would be populated by ViewChild decorator.
      scalarCardComponent.componentInstance.lineChart =
        lineChartComponent.componentInstance;
    }
    return fixture;
  }

  function triggerStoreUpdate() {
    store.refreshState();
    // Flush the debounce on the `seriesDataList$`.
    tick(0);
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [
        MatIconTestingModule,
        MatMenuModule,
        MatProgressSpinnerModule,
        NoopAnimationsModule,
        ResizeDetectorTestingModule,
        TruncatedPathModule,
      ],
      declarations: [
        ScalarCardContainer,
        ScalarCardComponent,
        TestableLineChart,
        TestableGpuLineChart,
      ],
      providers: [
        provideMockStore({
          initialState: appStateFromMetricsState(buildMetricsState()),
        }),
      ],
    }).compileComponents();

    store = TestBed.inject<Store<State>>(Store) as MockStore<State>;
    selectSpy = spyOn(store, 'select').and.callThrough();
    overlayContainer = TestBed.inject(OverlayContainer);
    resizeTester = TestBed.inject(ResizeDetectorTestingModule);
    store.overrideSelector(selectors.getCurrentRouteRunSelection, new Map());
    store.overrideSelector(selectors.getExperimentIdForRunId, null);
    store.overrideSelector(selectors.getExperimentIdToAliasMap, {});
    store.overrideSelector(selectors.getRun, null);
    store.overrideSelector(selectors.getIsGpuChartEnabled, false);
    store.overrideSelector(selectors.getMetricsXAxisType, XAxisType.STEP);
  });

  it('renders empty chart when there is no data', fakeAsync(() => {
    const cardMetadata = {
      plugin: PluginType.SCALARS,
      tag: 'tagA',
      run: null,
    };
    provideMockCardRunToSeriesData(
      selectSpy,
      PluginType.SCALARS,
      'card1',
      cardMetadata,
      null /* runToSeries */
    );

    const fixture = createComponent('card1');

    const metadataEl = fixture.debugElement.query(By.css('.heading'));
    expect(metadataEl.nativeElement.textContent).toContain('tagA');

    const lineChartEl = fixture.debugElement.query(
      By.directive(TestableLineChart)
    );
    expect(lineChartEl).toBeTruthy();
    expect(lineChartEl.componentInstance.seriesDataList.length).toBe(0);
  }));

  it('renders loading spinner when loading', fakeAsync(() => {
    provideMockCardRunToSeriesData(selectSpy, PluginType.SCALARS, 'card1');
    store.overrideSelector(
      selectors.getCardLoadState,
      DataLoadState.NOT_LOADED
    );
    triggerStoreUpdate();

    const fixture = createComponent('card1');
    let loadingEl = fixture.debugElement.query(By.css('mat-spinner'));
    expect(loadingEl).not.toBeTruthy();

    store.overrideSelector(selectors.getCardLoadState, DataLoadState.LOADING);
    triggerStoreUpdate();
    fixture.detectChanges();
    loadingEl = fixture.debugElement.query(By.css('mat-spinner'));
    expect(loadingEl).toBeTruthy();

    store.overrideSelector(selectors.getCardLoadState, DataLoadState.LOADED);
    triggerStoreUpdate();
    fixture.detectChanges();
    loadingEl = fixture.debugElement.query(By.css('mat-spinner'));
    expect(loadingEl).not.toBeTruthy();

    store.overrideSelector(selectors.getCardLoadState, DataLoadState.FAILED);
    triggerStoreUpdate();
    fixture.detectChanges();
    loadingEl = fixture.debugElement.query(By.css('mat-spinner'));
    expect(loadingEl).not.toBeTruthy();
  }));

  it('renders data', fakeAsync(() => {
    const cardMetadata = {
      plugin: PluginType.SCALARS,
      tag: 'tagA',
      run: null,
    };
    const runToSeries = {
      run1: [
        {wallTime: 100, value: 1, step: 333},
        {wallTime: 101, value: 2, step: 555},
      ],
    };
    provideMockCardRunToSeriesData(
      selectSpy,
      PluginType.SCALARS,
      'card1',
      cardMetadata,
      runToSeries
    );
    store.overrideSelector(
      selectors.getCurrentRouteRunSelection,
      new Map([['run1', true]])
    );
    store.overrideSelector(selectors.getMetricsXAxisType, XAxisType.STEP);
    selectSpy
      .withArgs(selectors.getRun, {runId: 'run1'})
      .and.returnValue(of(buildRun({name: 'Run1 name'})));

    const fixture = createComponent('card1');

    const metadataEl = fixture.debugElement.query(By.css('.heading'));
    const emptyEl = fixture.debugElement.query(By.css('.empty-message'));
    expect(metadataEl.nativeElement.textContent).toContain('tagA');
    expect(emptyEl).not.toBeTruthy();

    const lineChartEl = fixture.debugElement.query(
      By.directive(TestableLineChart)
    );
    expect(lineChartEl).toBeTruthy();

    expect(lineChartEl.componentInstance.seriesDataList.length).toBe(1);
    const {
      seriesId,
      metadata,
      points,
      visible,
    } = lineChartEl.componentInstance.seriesDataList[0];
    expect(seriesId).toBe('run1');
    expect(metadata).toEqual({displayName: 'Run1 name'});
    expect(visible).toBe(true);
    expect(
      points.map((p: {x: number; y: number}) => ({x: p.x, y: p.y}))
    ).toEqual([
      {x: 333, y: 1},
      {x: 555, y: 2},
    ]);
  }));

  describe('displayName', () => {
    beforeEach(() => {
      const cardMetadata = {
        plugin: PluginType.SCALARS,
        tag: 'tagA',
        run: null,
      };
      const runToSeries = {run1: [{wallTime: 101, value: 2, step: 555}]};
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        cardMetadata,
        runToSeries
      );
    });

    it('sets correct displayName when there is a experiment map', fakeAsync(() => {
      selectSpy
        .withArgs(selectors.getExperimentIdForRunId, {runId: 'run1'})
        .and.returnValue(of('eid1'));
      selectSpy
        .withArgs(selectors.getRun, {runId: 'run1'})
        .and.returnValue(of(buildRun({name: 'Run1 name'})));
      store.overrideSelector(selectors.getExperimentIdToAliasMap, {
        eid1: 'existing_exp',
        eid2: 'ERROR!',
      });

      const fixture = createComponent('card1');

      const lineChartEl = fixture.debugElement.query(
        By.directive(TestableLineChart)
      );
      const {
        seriesId,
        metadata,
      } = lineChartEl.componentInstance.seriesDataList[0];

      expect(seriesId).toBe('run1');
      expect(metadata).toEqual({displayName: 'existing_exp/Run1 name'});
    }));

    it('sets run id if a run and experiment are not found', fakeAsync(() => {
      selectSpy
        .withArgs(selectors.getExperimentIdForRunId, {runId: 'run1'})
        .and.returnValue(of(null));
      selectSpy
        .withArgs(selectors.getRun, {runId: 'run1'})
        .and.returnValue(of(null));
      store.overrideSelector(selectors.getExperimentIdToAliasMap, {});

      const fixture = createComponent('card1');

      const lineChartEl = fixture.debugElement.query(
        By.directive(TestableLineChart)
      );
      const {
        seriesId,
        metadata,
      } = lineChartEl.componentInstance.seriesDataList[0];

      expect(seriesId).toBe('run1');
      expect(metadata).toEqual({displayName: 'run1'});
    }));

    it('shows experiment id and "..." if only run is not found (maybe loading)', fakeAsync(() => {
      selectSpy
        .withArgs(selectors.getExperimentIdForRunId, {runId: 'run1'})
        .and.returnValue(of('eid1'));
      selectSpy
        .withArgs(selectors.getRun, {runId: 'run1'})
        .and.returnValue(of(null));
      store.overrideSelector(selectors.getExperimentIdToAliasMap, {
        eid1: 'existing_exp',
      });

      const fixture = createComponent('card1');

      const lineChartEl = fixture.debugElement.query(
        By.directive(TestableLineChart)
      );
      expect(lineChartEl.componentInstance.seriesDataList.length).toBe(1);

      const {
        seriesId,
        metadata,
      } = lineChartEl.componentInstance.seriesDataList[0];
      expect(seriesId).toBe('run1');
      expect(metadata).toEqual({displayName: 'existing_exp/...'});
    }));

    it('updates displayName with run when run populates', fakeAsync(() => {
      const getRun = new ReplaySubject<Run | null>(1);
      getRun.next(null);
      selectSpy
        .withArgs(selectors.getExperimentIdForRunId, {runId: 'run1'})
        .and.returnValue(of('eid1'));
      selectSpy
        .withArgs(selectors.getRun, {runId: 'run1'})
        .and.returnValue(getRun);
      store.overrideSelector(selectors.getExperimentIdToAliasMap, {
        eid1: 'existing_exp',
      });

      const fixture = createComponent('card1');

      getRun.next(buildRun({name: 'Foobar'}));
      triggerStoreUpdate();
      fixture.detectChanges();

      const lineChartEl = fixture.debugElement.query(
        By.directive(TestableLineChart)
      );
      const {metadata} = lineChartEl.componentInstance.seriesDataList[0];
      expect(metadata).toEqual({displayName: 'existing_exp/Foobar'});
    }));
  });

  describe('xAxisType setting', () => {
    beforeEach(() => {
      const runToSeries = {
        run1: [
          {wallTime: 100, value: 1, step: 333},
          {wallTime: 101, value: 2, step: 555},
        ],
      };
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        null /* metadataOverride */,
        runToSeries
      );
      store.overrideSelector(
        selectors.getCurrentRouteRunSelection,
        new Map([['run1', true]])
      );
    });

    const expectedPoints = {
      step: [
        {x: 333, y: 1},
        {x: 555, y: 2},
      ],
      wallTime: [
        {x: 100, y: 1},
        {x: 101, y: 2},
      ],
    };

    const specs = [
      {
        name: 'step',
        xType: XAxisType.STEP,
        expectedPoints: expectedPoints.step,
      },
      {
        name: 'wall_time',
        xType: XAxisType.WALL_TIME,
        expectedPoints: expectedPoints.wallTime,
      },
      {
        name: 'relative',
        xType: XAxisType.RELATIVE,
        expectedPoints: expectedPoints.wallTime,
      },
    ];
    for (const spec of specs) {
      it(`formats series data when xAxisType is: ${spec.name}`, fakeAsync(() => {
        store.overrideSelector(selectors.getMetricsXAxisType, spec.xType);
        selectSpy
          .withArgs(selectors.getRun, {runId: 'run1'})
          .and.returnValue(of(buildRun({name: 'Run1 name'})));
        const fixture = createComponent('card1');

        const lineChartEl = fixture.debugElement.query(
          By.directive(TestableLineChart)
        );
        expect(lineChartEl.componentInstance.seriesDataList.length).toBe(1);
        const {
          seriesId,
          metadata,
          points,
          visible,
        } = lineChartEl.componentInstance.seriesDataList[0];
        expect(seriesId).toBe('run1');
        expect(metadata).toEqual({displayName: 'Run1 name'});
        expect(visible).toBe(true);
        expect(
          points.map((p: {x: number; y: number}) => ({x: p.x, y: p.y}))
        ).toEqual(spec.expectedPoints);
      }));
    }
  });

  it('uses proper default tooltip columns', fakeAsync(() => {
    const pointData1 = [
      {x: 10, y: 20, step: 10, wallTime: 120, value: 20},
      {x: 11, y: -20, step: 11, wallTime: 125, value: -20},
    ];
    const pointData2 = [{x: 12, y: 2, step: 12, wallTime: 130, value: 2}];
    const dataset1 = {
      metadata: () => ({meta: {displayName: 'run1'}}),
      data: () => pointData1,
    };
    const dataset2 = {
      metadata: () => ({meta: {displayName: 'run2'}}),
      data: () => pointData2,
    };
    const testChartPoints: ScalarChartEvalPoint[] = [
      {datum: pointData1[0], dataset: dataset1},
      {datum: pointData1[1], dataset: dataset1},
      {datum: pointData2[0], dataset: dataset2},
    ];

    const fixture = createComponent('cardId');
    const tooltipColumns: TooltipColumns = fixture.debugElement.query(
      By.directive(ScalarCardComponent)
    ).componentInstance.tooltipColumns;
    const results = tooltipColumns.map((column) => {
      return {
        title: column.title,
        results: testChartPoints.map((d) => column.evaluate(d)),
      };
    });

    const resultsWithoutTime = results.filter((r) => r.title !== 'Time');
    expect(resultsWithoutTime).toEqual([
      {
        title: 'Name',
        results: ['run1', 'run1', 'run2'],
      },
      {
        title: 'Value',
        results: ['20', '-20', '2'],
      },
      {
        title: 'Step',
        results: ['10', '11', '12'],
      },
      {
        title: 'Relative',
        results: ['0s', '5s', '0s'],
      },
    ]);
  }));

  it('respects settings from the store', fakeAsync(() => {
    const runToSeries = {
      run1: [
        {wallTime: 100, value: 1, step: 333},
        {wallTime: 101, value: 2, step: 555},
      ],
    };
    const expectedPoints = {
      step: [
        {x: 333, y: 1},
        {x: 555, y: 2},
      ],
      wallTime: [
        {x: 100, y: 1},
        {x: 101, y: 2},
      ],
    };
    provideMockCardRunToSeriesData(
      selectSpy,
      PluginType.SCALARS,
      'card1',
      null /* metadataOverride */,
      runToSeries
    );
    store.overrideSelector(
      selectors.getCurrentRouteRunSelection,
      new Map([['run1', true]])
    );
    store.overrideSelector(
      selectors.getMetricsTooltipSort,
      TooltipSort.ASCENDING
    );
    store.overrideSelector(selectors.getMetricsIgnoreOutliers, true);
    store.overrideSelector(selectors.getMetricsXAxisType, XAxisType.STEP);
    store.overrideSelector(selectors.getMetricsScalarSmoothing, 1);

    const fixture = createComponent('card1');

    const lineChart = fixture.debugElement.query(
      By.directive(TestableLineChart)
    ).componentInstance;
    expect(lineChart.tooltipSortingMethod).toBe(TooltipSort.ASCENDING);
    expect(lineChart.ignoreYOutliers).toBe(true);
    expect(lineChart.xAxisType).toBe(ChartXAxisType.STEP);
    expect(lineChart.smoothingEnabled).toBe(true);
    expect(lineChart.smoothingWeight).toBe(1);
    expect(lineChart.seriesDataList.length).toBe(1);
    const pointsBefore = lineChart.seriesDataList[0].points.map(
      (p: {x: number; y: number}) => {
        return {x: p.x, y: p.y};
      }
    );
    expect(pointsBefore).toEqual(expectedPoints.step);

    store.overrideSelector(
      selectors.getMetricsTooltipSort,
      TooltipSort.DESCENDING
    );
    store.overrideSelector(selectors.getMetricsIgnoreOutliers, false);
    store.overrideSelector(selectors.getMetricsXAxisType, XAxisType.WALL_TIME);
    store.overrideSelector(selectors.getMetricsScalarSmoothing, 0);
    triggerStoreUpdate();

    fixture.detectChanges();

    expect(lineChart.tooltipSortingMethod).toBe(TooltipSort.DESCENDING);
    expect(lineChart.ignoreYOutliers).toBe(false);
    expect(lineChart.xAxisType).toBe(ChartXAxisType.WALL_TIME);
    expect(lineChart.smoothingEnabled).toBe(false);
    expect(lineChart.smoothingWeight).toBe(0);
    expect(lineChart.seriesDataList.length).toBe(1);
    const pointsAfter = lineChart.seriesDataList[0].points.map(
      (p: {x: number; y: number}) => {
        return {x: p.x, y: p.y};
      }
    );
    expect(pointsAfter).toEqual(expectedPoints.wallTime);
  }));

  it('respects run selection state', fakeAsync(() => {
    const runToSeries = {
      run1: [{wallTime: 100, value: 1, step: 333}],
      run2: [{wallTime: 100, value: 1, step: 333}],
      run3: [{wallTime: 100, value: 1, step: 333}],
    };
    provideMockCardRunToSeriesData(
      selectSpy,
      PluginType.SCALARS,
      'card1',
      null /* metadataOverride */,
      runToSeries
    );
    store.overrideSelector(
      selectors.getCurrentRouteRunSelection,
      new Map([
        ['run1', true],
        ['run2', false],
      ])
    );

    const fixture = createComponent('card1');

    const lineChart = fixture.debugElement.query(
      By.directive(TestableLineChart)
    ).componentInstance as TestableLineChart;
    let visibleRunIds = lineChart.seriesDataList
      .filter((x) => x.visible)
      .map((x) => x.seriesId);
    expect(lineChart.seriesDataList.length).toBe(3);
    expect(visibleRunIds).toEqual(['run1']);

    store.overrideSelector(
      selectors.getCurrentRouteRunSelection,
      new Map([
        ['run1', false],
        ['run3', true],
      ])
    );
    triggerStoreUpdate();
    fixture.detectChanges();

    visibleRunIds = lineChart.seriesDataList
      .filter((x) => x.visible)
      .map((x) => x.seriesId);
    expect(lineChart.seriesDataList.length).toBe(3);
    expect(visibleRunIds).toEqual(['run3']);
  }));

  describe('overflow menu', () => {
    beforeEach(() => {
      const runToSeries = {
        run1: [
          {wallTime: 100, value: 1, step: 333},
          {wallTime: 101, value: 2, step: 555},
        ],
      };
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        null /* metadataOverride */,
        runToSeries
      );
    });

    it('toggles yAxisType when you click on button in overflow menu', fakeAsync(() => {
      const fixture = createComponent('card1');

      openOverflowMenu(fixture);
      getMenuButton('Toggle Y-axis log scale on line chart').click();
      fixture.detectChanges();

      const lineChartEl = fixture.debugElement.query(
        By.directive(TestableLineChart)
      );
      expect(lineChartEl.componentInstance.yAxisType).toBe(YAxisType.LOG);

      openOverflowMenu(fixture);
      getMenuButton('Toggle Y-axis log scale on line chart').click();
      fixture.detectChanges();

      expect(lineChartEl.componentInstance.yAxisType).toBe(YAxisType.LINEAR);

      // Clicking on overflow menu and mat button enqueue asyncs. Flush them.
      flush();
    }));

    it('resets domain when user clicks on reset button', fakeAsync(() => {
      const fixture = createComponent('card1');

      const lineChartEl = fixture.debugElement.query(
        By.directive(TestableLineChart)
      );
      const resetDomainSpy = spyOn(
        lineChartEl.componentInstance,
        'resetDomain'
      );

      openOverflowMenu(fixture);
      getMenuButton('Fit line chart domains to data').click();
      fixture.detectChanges();

      expect(resetDomainSpy).toHaveBeenCalledTimes(1);

      // Clicking on overflow menu and mat button enqueue asyncs. Flush them.
      flush();
    }));

    it('disables the resetDomain button when there are no runs', fakeAsync(() => {
      const runToSeries = {};
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        null /* metadataOverride */,
        runToSeries
      );
      const fixture = createComponent('card1');

      openOverflowMenu(fixture);
      const button = getMenuButton('Fit line chart domains to data');
      expect(button.disabled).toBe(true);

      // Clicking on overflow menu enqueues async.
      flush();
    }));
  });

  describe('full size', () => {
    beforeEach(() => {
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        null /* metadataOverride */
      );
    });

    it('requests full size on toggle', fakeAsync(() => {
      const onFullWidthChanged = jasmine.createSpy();
      const onFullHeightChanged = jasmine.createSpy();
      const fixture = createComponent('card1');
      fixture.detectChanges();

      fixture.componentInstance.fullWidthChanged.subscribe(onFullWidthChanged);
      fixture.componentInstance.fullHeightChanged.subscribe(
        onFullHeightChanged
      );
      const button = fixture.debugElement.query(
        By.css('[aria-label="Toggle full size mode"]')
      );

      button.nativeElement.click();
      expect(onFullWidthChanged.calls.allArgs()).toEqual([[true]]);
      expect(onFullHeightChanged.calls.allArgs()).toEqual([[true]]);

      button.nativeElement.click();
      expect(onFullWidthChanged.calls.allArgs()).toEqual([[true], [false]]);
      expect(onFullHeightChanged.calls.allArgs()).toEqual([[true], [false]]);
    }));
  });

  describe('resize', () => {
    beforeEach(() => {
      const runToSeries = {
        run1: [
          {wallTime: 100, value: 1, step: 333},
          {wallTime: 101, value: 2, step: 555},
        ],
      };
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        null /* metadataOverride */,
        runToSeries
      );
    });

    it('calls redraw on resize', fakeAsync(() => {
      const fixture = createComponent('card1');
      const lineChartComponent = fixture.debugElement.query(
        By.directive(TestableLineChart)
      );

      const redrawSpy = spyOn(lineChartComponent.componentInstance, 'redraw');

      resizeTester.simulateResize(fixture);

      expect(redrawSpy).toHaveBeenCalledTimes(1);
    }));
  });

  describe('perf', () => {
    it('does not update `seriesDataList` for irrelevant runSelection changes', fakeAsync(() => {
      const runToSeries = {run1: []};
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        null /* metadataOverride */,
        runToSeries
      );
      store.overrideSelector(
        selectors.getCurrentRouteRunSelection,
        new Map([['run1', true]])
      );

      const fixture = createComponent('card1');
      const lineChartComponent = fixture.debugElement.query(
        By.directive(TestableLineChart)
      );
      const before = lineChartComponent.componentInstance.seriesDataList;

      store.overrideSelector(
        selectors.getCurrentRouteRunSelection,
        new Map([
          ['run1', true],
          ['shouldBeNoop', true],
        ])
      );
      triggerStoreUpdate();
      fixture.detectChanges();

      const after = lineChartComponent.componentInstance.seriesDataList;
      expect(before).toBe(after);
    }));

    it('updates `seriesDataList` for relevant runSelection changes', fakeAsync(() => {
      const runToSeries = {run1: []};
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        null /* metadataOverride */,
        runToSeries
      );
      store.overrideSelector(
        selectors.getCurrentRouteRunSelection,
        new Map([['run1', true]])
      );

      const fixture = createComponent('card1');
      const lineChartComponent = fixture.debugElement.query(
        By.directive(TestableLineChart)
      );
      const before = lineChartComponent.componentInstance.seriesDataList;

      store.overrideSelector(
        selectors.getCurrentRouteRunSelection,
        new Map([['run1', false]])
      );
      triggerStoreUpdate();
      fixture.detectChanges();

      const after = lineChartComponent.componentInstance.seriesDataList;
      expect(before).not.toBe(after);
    }));

    it('updates `seriesDataList` for xAxisType changes', fakeAsync(() => {
      const runToSeries = {
        run1: [
          {wallTime: 100, value: 1, step: 333},
          {wallTime: 101, value: 2, step: 555},
        ],
      };
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        null /* metadataOverride */,
        runToSeries
      );
      store.overrideSelector(selectors.getMetricsXAxisType, XAxisType.STEP);
      store.overrideSelector(
        selectors.getCurrentRouteRunSelection,
        new Map([['run1', true]])
      );

      const fixture = createComponent('card1');
      const lineChartComponent = fixture.debugElement.query(
        By.directive(TestableLineChart)
      );
      const before = lineChartComponent.componentInstance.seriesDataList;

      store.overrideSelector(
        selectors.getMetricsXAxisType,
        XAxisType.WALL_TIME
      );
      triggerStoreUpdate();
      fixture.detectChanges();

      const after = lineChartComponent.componentInstance.seriesDataList;
      expect(before).not.toBe(after);
    }));

    it('does not call the redraw when the card is invisible', fakeAsync(() => {
      const fixture = createComponent('card1');
      const lineChartComponent = fixture.debugElement.query(
        By.directive(TestableLineChart)
      );

      const redrawSpy = spyOn(lineChartComponent.componentInstance, 'redraw');

      fixture.nativeElement.style.display = 'none';
      resizeTester.simulateResize(fixture);
      expect(redrawSpy).not.toHaveBeenCalled();

      fixture.nativeElement.style.display = 'block';
      resizeTester.simulateResize(fixture);
      expect(redrawSpy).toHaveBeenCalledTimes(1);
    }));
  });

  describe('gpu line chart integration', () => {
    beforeEach(() => {
      store.overrideSelector(selectors.getIsGpuChartEnabled, true);
      store.overrideSelector(selectors.getRunColorMap, {});
      store.overrideSelector(selectors.getMetricsScalarSmoothing, 0.1);
    });

    const Selector = {
      GPU_LINE_CHART: By.directive(TestableGpuLineChart),
      SVG_LINE_CHART: By.directive(TestableLineChart),
      TOOLTIP_HEADER_COLUMN: By.css('table.tooltip th'),
      TOOLTIP_ROW: By.css('table.tooltip .tooltip-row'),
    };

    it('renders the gpu line chart instead of svg one', fakeAsync(() => {
      const fixture = createComponent('card1');
      expect(fixture.debugElement.query(Selector.SVG_LINE_CHART)).toBeNull();
      expect(
        fixture.debugElement.query(Selector.GPU_LINE_CHART)
      ).not.toBeNull();
    }));

    it('passes data series and metadata with smoothed values', fakeAsync(() => {
      store.overrideSelector(selectors.getMetricsXAxisType, XAxisType.STEP);
      store.overrideSelector(selectors.getRunColorMap, {
        run1: '#f00',
        run2: '#0f0',
      });
      store.overrideSelector(selectors.getMetricsScalarSmoothing, 0.1);

      const runToSeries = {
        run1: [
          {wallTime: 2, value: 1, step: 1},
          {wallTime: 4, value: 10, step: 2},
        ],
        run2: [{wallTime: 2, value: 1, step: 1}],
      };
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        null /* metadataOverride */,
        runToSeries
      );

      const fixture = createComponent('card1');
      const lineChart = fixture.debugElement.query(Selector.GPU_LINE_CHART);

      expect(lineChart.componentInstance.seriesData).toEqual([
        {
          id: 'run1',
          points: [
            // Keeps the data structure as is but do notice adjusted wallTime and
            // line_chart_v2 required "x" and "y" props.
            {wallTime: 2000, value: 1, step: 1, x: 1, y: 1},
            {wallTime: 4000, value: 10, step: 2, x: 2, y: 10},
          ],
        },
        {id: 'run2', points: [{wallTime: 2000, value: 1, step: 1, x: 1, y: 1}]},
        {
          id: '["smoothed","run1"]',
          points: [
            {wallTime: 2000, value: 1, step: 1, x: 1, y: 1},
            // Exact smoothed value is not too important.
            {wallTime: 4000, value: 10, step: 2, x: 2, y: jasmine.any(Number)},
          ],
        },
        {
          id: '["smoothed","run2"]',
          points: [{wallTime: 2000, value: 1, step: 1, x: 1, y: 1}],
        },
      ]);
      expect(lineChart.componentInstance.seriesMetadataMap).toEqual({
        run1: {
          id: 'run1',
          displayName: 'run1',
          type: SeriesType.ORIGINAL,
          visible: false,
          color: '#f00',
          opacity: 0.4,
          aux: true,
        },
        run2: {
          id: 'run2',
          displayName: 'run2',
          type: SeriesType.ORIGINAL,
          visible: false,
          color: '#0f0',
          opacity: 0.4,
          aux: true,
        },
        '["smoothed","run1"]': {
          id: '["smoothed","run1"]',
          displayName: 'run1',
          type: SeriesType.DERIVED,
          originalSeriesId: 'run1',
          visible: false,
          color: '#f00',
          opacity: 1,
          aux: false,
        },
        '["smoothed","run2"]': {
          id: '["smoothed","run2"]',
          displayName: 'run2',
          type: SeriesType.DERIVED,
          originalSeriesId: 'run2',
          visible: false,
          color: '#0f0',
          opacity: 1,
          aux: false,
        },
      });
    }));

    it('does not set smoothed series when it is disabled,', fakeAsync(() => {
      store.overrideSelector(selectors.getMetricsXAxisType, XAxisType.STEP);
      store.overrideSelector(selectors.getRunColorMap, {
        run1: '#f00',
        run2: '#0f0',
      });
      store.overrideSelector(selectors.getMetricsScalarSmoothing, 0);
      const runToSeries = {
        run1: [
          {wallTime: 2, value: 1, step: 1},
          {wallTime: 4, value: 10, step: 2},
        ],
        run2: [{wallTime: 2, value: 1, step: 1}],
      };
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        null /* metadataOverride */,
        runToSeries
      );

      const fixture = createComponent('card1');
      const lineChart = fixture.debugElement.query(Selector.GPU_LINE_CHART);

      expect(lineChart.componentInstance.seriesData).toEqual([
        {
          id: 'run1',
          points: [
            // Keeps the data structure as is but requires "x" and "y" props.
            {wallTime: 2000, value: 1, step: 1, x: 1, y: 1},
            {wallTime: 4000, value: 10, step: 2, x: 2, y: 10},
          ],
        },
        {id: 'run2', points: [{wallTime: 2000, value: 1, step: 1, x: 1, y: 1}]},
      ]);
      expect(lineChart.componentInstance.seriesMetadataMap).toEqual({
        run1: {
          id: 'run1',
          displayName: 'run1',
          type: SeriesType.ORIGINAL,
          visible: false,
          color: '#f00',
          opacity: 1,
          aux: false,
        },
        run2: {
          id: 'run2',
          displayName: 'run2',
          type: SeriesType.ORIGINAL,
          visible: false,
          color: '#0f0',
          opacity: 1,
          aux: false,
        },
      });
    }));

    it('sets relative wallTime value to x when XAxisType is RELATIVE', fakeAsync(() => {
      store.overrideSelector(selectors.getMetricsXAxisType, XAxisType.RELATIVE);
      store.overrideSelector(selectors.getRunColorMap, {
        run1: '#f00',
        run2: '#0f0',
      });
      store.overrideSelector(selectors.getMetricsScalarSmoothing, 0);
      const runToSeries = {
        run1: [
          {wallTime: 2, value: 1, step: 1},
          {wallTime: 4, value: 10, step: 2},
          {wallTime: 2, value: 5, step: 3},
          {wallTime: 0, value: 0, step: 4},
        ],
        run2: [{wallTime: 2, value: 1, step: 1}],
      };
      provideMockCardRunToSeriesData(
        selectSpy,
        PluginType.SCALARS,
        'card1',
        null /* metadataOverride */,
        runToSeries
      );

      const fixture = createComponent('card1');
      const lineChart = fixture.debugElement.query(Selector.GPU_LINE_CHART);

      expect(lineChart.componentInstance.seriesData).toEqual([
        {
          id: 'run1',
          points: [
            {wallTime: 2000, value: 1, step: 1, x: 0, y: 1},
            {wallTime: 4000, value: 10, step: 2, x: 2000, y: 10},
            {wallTime: 2000, value: 5, step: 3, x: 0, y: 5},
            {wallTime: 0, value: 0, step: 4, x: -2000, y: 0},
          ],
        },
        {id: 'run2', points: [{wallTime: 2000, value: 1, step: 1, x: 0, y: 1}]},
      ]);
    }));

    describe('tooltip', () => {
      function buildTooltipDatum(
        metadata?: ScalarCardSeriesMetadata,
        point: Partial<ScalarCardPoint> = {}
      ): TooltipDatum<ScalarCardSeriesMetadata, ScalarCardPoint> {
        return {
          id: metadata?.id ?? 'a',
          metadata: {
            type: SeriesType.ORIGINAL,
            id: 'a',
            displayName: 'A name',
            visible: true,
            color: '#f00',
            ...metadata,
          },
          closestPointIndex: 0,
          point: {x: 0, y: 0, value: 0, step: 0, wallTime: 0, ...point},
        };
      }

      function setTooltipData(
        fixture: ComponentFixture<ScalarCardContainer>,
        tooltipData: TooltipDatum[]
      ) {
        const lineChart = fixture.debugElement.query(Selector.GPU_LINE_CHART);

        lineChart.componentInstance.tooltipDataForTesting = tooltipData;
        lineChart.componentInstance.changeDetectorRef.markForCheck();
      }

      function setCursorLocation(
        fixture: ComponentFixture<ScalarCardContainer>,
        cursorLocInDataCoord?: {x: number; y: number}
      ) {
        const lineChart = fixture.debugElement.query(Selector.GPU_LINE_CHART);

        lineChart.componentInstance.cursorLocForTesting = cursorLocInDataCoord;
        lineChart.componentInstance.changeDetectorRef.markForCheck();
      }

      function assertTooltipRows(
        fixture: ComponentFixture<ScalarCardContainer>,
        expectedTableContent: Array<
          Array<string | ReturnType<typeof jasmine.any>>
        >
      ) {
        const rows = fixture.debugElement.queryAll(Selector.TOOLTIP_ROW);
        const tableContent = rows.map((row) => {
          return row
            .queryAll(By.css('td'))
            .map((td) => td.nativeElement.textContent.trim());
        });

        expect(tableContent).toEqual(expectedTableContent);
      }

      it('renders the tooltip using the custom template (no smooth)', fakeAsync(() => {
        store.overrideSelector(selectors.getMetricsScalarSmoothing, 0);
        const fixture = createComponent('card1');
        setTooltipData(fixture, [
          buildTooltipDatum(
            {
              id: 'row1',
              type: SeriesType.ORIGINAL,
              displayName: 'Row 1',
              visible: true,
              color: '#00f',
            },
            {
              x: 10,
              step: 10,
              y: 1000,
              value: 1000,
              wallTime: new Date('2020-01-01').getTime(),
            }
          ),
          buildTooltipDatum(
            {
              id: 'row2',
              type: SeriesType.ORIGINAL,
              displayName: 'Row 2',
              visible: true,
              color: '#0f0',
            },
            {
              x: 1000,
              step: 1000,
              y: -1000,
              value: -1000,
              wallTime: new Date('2020-12-31').getTime(),
            }
          ),
        ]);
        fixture.detectChanges();

        const headerCols = fixture.debugElement.queryAll(
          Selector.TOOLTIP_HEADER_COLUMN
        );
        const headerText = headerCols.map(
          (col) => col.nativeElement.textContent
        );
        expect(headerText).toEqual(['', 'Run', 'Value', 'Step', 'Time']);

        assertTooltipRows(fixture, [
          ['', 'Row 1', '1000', '10', '1/1/20, 12:00 AM'],
          ['', 'Row 2', '-1000', '1,000', '12/31/20, 12:00 AM'],
        ]);
      }));

      it('renders the tooltip using the custom template (smooth)', fakeAsync(() => {
        store.overrideSelector(selectors.getMetricsScalarSmoothing, 0.5);
        const fixture = createComponent('card1');
        setTooltipData(fixture, [
          buildTooltipDatum(
            {
              id: 'smoothed_row1',
              type: SeriesType.DERIVED,
              displayName: 'Row 1',
              visible: true,
              color: '#00f',
              aux: false,
              originalSeriesId: 'row1',
            },
            {
              x: 10,
              step: 10,
              y: 500,
              value: 1000,
              wallTime: new Date('2020-01-01').getTime(),
            }
          ),
          buildTooltipDatum(
            {
              id: 'smoothed_row2',
              type: SeriesType.DERIVED,
              displayName: 'Row 2',
              visible: true,
              color: '#0f0',
              aux: false,
              originalSeriesId: 'row2',
            },
            {
              x: 1000,
              step: 1000,
              y: -500,
              value: -1000,
              wallTime: new Date('2020-12-31').getTime(),
            }
          ),
        ]);
        fixture.detectChanges();

        const headerCols = fixture.debugElement.queryAll(
          Selector.TOOLTIP_HEADER_COLUMN
        );
        const headerText = headerCols.map(
          (col) => col.nativeElement.textContent
        );
        expect(headerText).toEqual([
          '',
          'Run',
          'Smoothed',
          'Value',
          'Step',
          'Time',
        ]);

        assertTooltipRows(fixture, [
          ['', 'Row 1', '500', '1000', '10', '1/1/20, 12:00 AM'],
          // Print the step with comma for readability. The value is yet optimize for
          // readability (we may use the scientific formatting).
          ['', 'Row 2', '-500', '-1000', '1,000', '12/31/20, 12:00 AM'],
        ]);
      }));

      it('shows relative time when XAxisType is RELATIVE', fakeAsync(() => {
        store.overrideSelector(
          selectors.getMetricsXAxisType,
          XAxisType.RELATIVE
        );
        store.overrideSelector(selectors.getMetricsScalarSmoothing, 0);
        const fixture = createComponent('card1');
        setTooltipData(fixture, [
          buildTooltipDatum(
            {
              id: 'smoothed_row1',
              type: SeriesType.DERIVED,
              displayName: 'Row 1',
              visible: true,
              color: '#00f',
              aux: false,
              originalSeriesId: 'row1',
            },
            {
              x: 10,
              step: 10,
              y: 1000,
              value: 1000,
              wallTime: new Date('2020-01-01').getTime(),
            }
          ),
          buildTooltipDatum(
            {
              id: 'smoothed_row2',
              type: SeriesType.DERIVED,
              displayName: 'Row 2',
              visible: true,
              color: '#0f0',
              aux: false,
              originalSeriesId: 'row2',
            },
            {
              x: 432000000,
              step: 1000,
              y: -1000,
              value: -1000,
              wallTime: new Date('2020-01-05').getTime(),
            }
          ),
        ]);
        fixture.detectChanges();

        const headerCols = fixture.debugElement.queryAll(
          Selector.TOOLTIP_HEADER_COLUMN
        );
        const headerText = headerCols.map(
          (col) => col.nativeElement.textContent
        );
        expect(headerText).toEqual([
          '',
          'Run',
          'Value',
          'Step',
          'Time',
          'Relative',
        ]);

        const rows = fixture.debugElement.queryAll(Selector.TOOLTIP_ROW);
        const tableContent = rows.map((row) => {
          return row
            .queryAll(By.css('td'))
            .map((td) => td.nativeElement.textContent.trim());
        });

        expect(tableContent).toEqual([
          ['', 'Row 1', '1000', '10', '1/1/20, 12:00 AM', '10 ms'],
          ['', 'Row 2', '-1000', '1,000', '1/5/20, 12:00 AM', '5 day'],
        ]);
      }));

      it('sorts by ascending', fakeAsync(() => {
        store.overrideSelector(
          selectors.getMetricsTooltipSort,
          TooltipSort.ASCENDING
        );
        store.overrideSelector(selectors.getMetricsScalarSmoothing, 0);
        const fixture = createComponent('card1');
        setTooltipData(fixture, [
          buildTooltipDatum(
            {
              id: 'row1',
              type: SeriesType.ORIGINAL,
              displayName: 'Row 1',
              visible: true,
              color: '#f00',
              aux: false,
            },
            {
              x: 10,
              step: 10,
              y: 1000,
              value: 1000,
              wallTime: new Date('2020-01-01').getTime(),
            }
          ),
          buildTooltipDatum(
            {
              id: 'row2',
              type: SeriesType.ORIGINAL,
              displayName: 'Row 2',
              visible: true,
              color: '#0f0',
              aux: false,
            },
            {
              x: 1000,
              step: 1000,
              y: -500,
              value: -500,
              wallTime: new Date('2020-12-31').getTime(),
            }
          ),
          buildTooltipDatum(
            {
              id: 'row3',
              type: SeriesType.ORIGINAL,
              displayName: 'Row 3',
              visible: true,
              color: '#00f',
              aux: false,
            },
            {
              x: 10000,
              step: 10000,
              y: 3,
              value: 3,
              wallTime: new Date('2021-01-01').getTime(),
            }
          ),
        ]);
        fixture.detectChanges();

        assertTooltipRows(fixture, [
          ['', 'Row 2', '-500', '1,000', jasmine.any(String)],
          ['', 'Row 3', '3', '10,000', jasmine.any(String)],
          ['', 'Row 1', '1000', '10', jasmine.any(String)],
        ]);
      }));

      it('sorts by descending', fakeAsync(() => {
        store.overrideSelector(
          selectors.getMetricsTooltipSort,
          TooltipSort.DESCENDING
        );
        store.overrideSelector(selectors.getMetricsScalarSmoothing, 0);
        const fixture = createComponent('card1');
        setTooltipData(fixture, [
          buildTooltipDatum(
            {
              id: 'row1',
              type: SeriesType.ORIGINAL,
              displayName: 'Row 1',
              visible: true,
              color: '#f00',
              aux: false,
            },
            {
              x: 10,
              step: 10,
              y: 1000,
              value: 1000,
              wallTime: new Date('2020-01-01').getTime(),
            }
          ),
          buildTooltipDatum(
            {
              id: 'row2',
              type: SeriesType.ORIGINAL,
              displayName: 'Row 2',
              visible: true,
              color: '#0f0',
              aux: false,
            },
            {
              x: 1000,
              step: 1000,
              y: -500,
              value: -500,
              wallTime: new Date('2020-12-31').getTime(),
            }
          ),
          buildTooltipDatum(
            {
              id: 'row3',
              type: SeriesType.ORIGINAL,
              displayName: 'Row 3',
              visible: true,
              color: '#00f',
              aux: false,
            },
            {
              x: 10000,
              step: 10000,
              y: 3,
              value: 3,
              wallTime: new Date('2021-01-01').getTime(),
            }
          ),
        ]);
        fixture.detectChanges();

        assertTooltipRows(fixture, [
          ['', 'Row 1', '1000', '10', jasmine.any(String)],
          ['', 'Row 3', '3', '10,000', jasmine.any(String)],
          ['', 'Row 2', '-500', '1,000', jasmine.any(String)],
        ]);
      }));

      it('sorts by nearest to the cursor', fakeAsync(() => {
        store.overrideSelector(
          selectors.getMetricsTooltipSort,
          TooltipSort.NEAREST
        );
        store.overrideSelector(selectors.getMetricsScalarSmoothing, 0);
        const fixture = createComponent('card1');
        setTooltipData(fixture, [
          buildTooltipDatum(
            {
              id: 'row1',
              type: SeriesType.ORIGINAL,
              displayName: 'Row 1',
              visible: true,
              color: '#f00',
              aux: false,
            },
            {
              x: 0,
              step: 0,
              y: 1000,
              value: 1000,
              wallTime: new Date('2020-01-01').getTime(),
            }
          ),
          buildTooltipDatum(
            {
              id: 'row2',
              type: SeriesType.ORIGINAL,
              displayName: 'Row 2',
              visible: true,
              color: '#0f0',
              aux: false,
            },
            {
              x: 1000,
              step: 1000,
              y: -500,
              value: -500,
              wallTime: new Date('2020-12-31').getTime(),
            }
          ),
          buildTooltipDatum(
            {
              id: 'row3',
              type: SeriesType.ORIGINAL,
              displayName: 'Row 3',
              visible: true,
              color: '#00f',
              aux: false,
            },
            {
              x: 10000,
              step: 10000,
              y: 3,
              value: 3,
              wallTime: new Date('2021-01-01').getTime(),
            }
          ),
        ]);
        setCursorLocation(fixture, {x: 500, y: -100});
        fixture.detectChanges();
        assertTooltipRows(fixture, [
          ['', 'Row 2', '-500', '1,000', jasmine.any(String)],
          ['', 'Row 1', '1000', '0', jasmine.any(String)],
          ['', 'Row 3', '3', '10,000', jasmine.any(String)],
        ]);

        setCursorLocation(fixture, {x: 500, y: 600});
        fixture.detectChanges();
        assertTooltipRows(fixture, [
          ['', 'Row 1', '1000', '0', jasmine.any(String)],
          ['', 'Row 2', '-500', '1,000', jasmine.any(String)],
          ['', 'Row 3', '3', '10,000', jasmine.any(String)],
        ]);

        setCursorLocation(fixture, {x: 10000, y: -100});
        fixture.detectChanges();
        assertTooltipRows(fixture, [
          ['', 'Row 3', '3', '10,000', jasmine.any(String)],
          ['', 'Row 2', '-500', '1,000', jasmine.any(String)],
          ['', 'Row 1', '1000', '0', jasmine.any(String)],
        ]);

        // Right between row 1 and row 2. When tied, original order is used.
        setCursorLocation(fixture, {x: 500, y: 250});
        fixture.detectChanges();
        assertTooltipRows(fixture, [
          ['', 'Row 1', '1000', '0', jasmine.any(String)],
          ['', 'Row 2', '-500', '1,000', jasmine.any(String)],
          ['', 'Row 3', '3', '10,000', jasmine.any(String)],
        ]);
      }));
    });
  });
});
