import { Component, OnInit, Input, ChangeDetectionStrategy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Incident } from '../models/incident';
import { Responder } from '../models/responder';
import { Shelter } from '../models/shelter';
import { AppUtil } from '../app-util';
import { ResponderService } from '../services/responder.service';
import { IncidentService } from '../services/incident.service';
import { Mission } from '../models/mission';
import { LineLayout, LinePaint, LngLatBoundsLike, FitBoundsOptions, LngLat, Point,
          MapMouseEvent, Map, Marker, NavigationControl } from 'mapbox-gl';
import { default as MapboxDraw } from '@mapbox/mapbox-gl-draw';
import { CircleMode, DragCircleMode, DirectMode, SimpleSelectMode } from 'mapbox-gl-draw-circle';
import { default as DrawStyles } from './util/draw-styles.js';
import { PriorityZone } from '../models/priority-zone';

@Component({
  selector: 'app-map',
  templateUrl: './map.component.html',
  styleUrls: ['./map.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class MapComponent implements OnInit {
  @Input() responders: Responder[];
  @Input() incidents: Incident[];
  @Input() shelters: Shelter[];
  @Input() missions: Mission[];
  @Input() priorityZones: PriorityZone[];

  map: Map;
  mapDrawTools: MapboxDraw;

  center: number[] = AppUtil.isMobile() ? [-77.886765, 34.139921] : [-77.886765, 34.158808];
  accessToken: string = window['_env'].accessToken;

  pickupData: GeoJSON.FeatureCollection<GeoJSON.LineString> = AppUtil.initGeoJson();
  deliverData: GeoJSON.FeatureCollection<GeoJSON.LineString> = AppUtil.initGeoJson();
  zoom: number[] = [AppUtil.isMobile() ? 10 : 10.5];
  enableDrawingPriorityZones = false;  // TODO make a button to toggle this?
  priZoneButtonText = 'Create Priority Zone';

  bounds: LngLatBoundsLike;
  boundsOptions: FitBoundsOptions = {
    padding: 50
  };

  lineLayout: LineLayout = {
    'line-join': 'round',
    'line-cap': 'round'
  };

  readonly GREY = '#a4b7c1';
  readonly YELLOW = '#ffc107';
  readonly BLUE = '#20a8d8';
  readonly RED = '#f86c6b';
  readonly GREEN = '#4dbd74';

  pickupPaint: LinePaint = {
    'line-color': this.YELLOW,
    'line-width': 8
  };

  deliverPaint: LinePaint = {
    'line-color': this.BLUE,
    'line-width': 8
  };

  shelterStyle: any = {
    'background-image': 'url(assets/img/shelter.svg)'
  };

  constructor(public responderService: ResponderService, public incidentService: IncidentService, private httpClient: HttpClient) { }

  get currentIncidents(): Incident[] {
    return this.incidents.filter(i => i.status !== 'RESCUED');
  }

  get activeResponders(): Responder[] {
    return this.responders;
  }

  markerClick(lngLat: number[]): void {
    this.center = lngLat;
  }

  // icons colored with coreui hex codes from https://iconscout.com/icon/location-62
  getIncidentIcon(incident: Incident): string {
    return !incident.status || incident.status === 'REPORTED' ? 'marker-red.svg' : 'marker-yellow.svg';
  }

  getResponderIcon(person: boolean): string {
    return (person ? 'responder-person.svg' : 'responder.svg');
  }

  getResponderMission(responder: Responder) {
    return this.missions.find(m => m.responderId === responder.id && m.status !== 'COMPLETED');
  }

  getIncidentMission(incident: Incident) {
    return this.missions.find(m => m.incidentId === incident.id);
  }

  onResponderPopup(responder: Responder): void {
    const mission = this.getResponderMission(responder);
    if (!mission) {
      return;
    }
    this.onPopup(mission);
  }

  onIncidentPopup(incident: Incident): void {
    const mission = this.getIncidentMission(incident);
    if (!mission) {
      return;
    }
    this.onPopup(mission);
  }

  public onPopup(mission: Mission): void {
    if (!mission || mission.status === 'COMPLETED') {
      return;
    }

    this.pickupData.features[0].geometry.coordinates = [];
    this.pickupData = { ...this.pickupData };
    this.deliverData.features[0].geometry.coordinates = [];
    this.deliverData = { ...this.deliverData };
    const missionRoute = AppUtil.getRoute(mission.id, mission.steps);
    if (!missionRoute) {
      return;
    }

    this.pickupData.features[0].geometry.coordinates = missionRoute.pickupRoute;
    this.deliverData.features[0].geometry.coordinates = missionRoute.deliverRoute;
    this.pickupData = { ...this.pickupData };
    this.deliverData = { ...this.deliverData };
    this.bounds = AppUtil.getBounds(missionRoute.pickupRoute.concat(missionRoute.deliverRoute));
  }

  ngOnInit() {
  }

  getLLFromFeatureData(data): LngLat {
    if (data.type != "Feature") { return null; } // error, not a feature
    return new LngLat(+data.properties.center[0], +data.properties.center[1]);
  }

  projectFeatureDataToPoint(data): Point {
    return this.map.project(this.getLLFromFeatureData(data));
  }

  public onDrawPriorityZoneButtonClick(): void {
    this.enableDrawingPriorityZones = !this.enableDrawingPriorityZones; // toggle mode
    if (this.enableDrawingPriorityZones === true) { // toggled on
      this.priZoneButtonText = 'Done Drawing';
      this.mapDrawTools.changeMode('drag_circle', { initialRadiusInKm: 2 });
    } else { // toggled off
      this.priZoneButtonText = 'Create Priority Zone';
      this.mapDrawTools.changeMode('simple_select', { initialRadiusInKm: 2 });

      const data = this.mapDrawTools.getAll();
      if (data.features) {
        data.features.forEach(function(feature) {
          // alert(JSON.stringify(feature));
          //e.g. feature.properties {"isCircle":true,"center":[-78.05985704920441,34.139520841135806],"radiusInKm":4.440545224272349}
          if (feature.properties.isCircle === true) {
            this.addedOrUpdatedPriorityZone(feature.id, feature.properties.center[0], feature.properties.center[1], feature.radiusInKm);
          }
        });
      }
    }
  }

  public onPriorityZoneDeleteButtonClick(): void {
    this.mapDrawTools.deleteAll();
  }

  // Fired when a feature is created. The following interactions will trigger this event:
  // Finish drawing a feature.
  // Simply clicking will create a Point.
  // A LineString or Polygon is only created when the user has finished drawing it
  // i.e. double-clicked the last vertex or hit Enter — and the drawn feature is valid.
  //
  // The event data is an object - features: Array<Object>
  public createdDrawArea(event) {
    // TODO?
  }

  // Fired when one or more features are updated. The following interactions will trigger
  // this event, which can be subcategorized by action:
  // action: 'move'
  //   * Finish moving one or more selected features in simple_select mode. 
  //     The event will only fire when the movement is finished (i.e. when the user
  //     releases the mouse button or hits Enter).
  // action: 'change_coordinates'
  //   * Finish moving one or more vertices of a selected feature in direct_select mode. 
  //     The event will only fire when the movement is finished (i.e. when the user releases
  //     the mouse button or hits Enter, or her mouse leaves the map container).
  //   * Delete one or more vertices of a selected feature in direct_select mode, which can
  //     be done by hitting the Backspace or Delete keys, clicking the Trash button, or invoking draw.trash().
  //   * Add a vertex to the selected feature by clicking a midpoint on that feature in direct_select mode.
  //
  // This event will not fire when a feature is created or deleted. To track those interactions, listen for draw.create and draw.delete events.
  //
  // The event data is an object - features: Array<Feature>, action: string
  public updatedDrawArea(event) {
    // TODO?
  }

  public onMapMouseDown(click: MapMouseEvent): void {}
  public onMapMouseUp(click: MapMouseEvent): void {}
  public onMapMouseMove(click: MapMouseEvent): void {}
  public onMapClick(click: MapMouseEvent): void {}

  public loadMap(map: Map): void {
    this.map = map;
    // MapBoxDraw gives us drawing and editing features in mapbox
    this.mapDrawTools = new MapboxDraw({
      defaultMode: 'simple_select',
      displayControlsDefault: false,
      userProperties: true,
      styles: DrawStyles,
      modes: {
        ...MapboxDraw.modes,
        draw_circle  : CircleMode,
        drag_circle  : DragCircleMode,
        direct_select: DirectMode,
        simple_select: SimpleSelectMode
      }
    });
    this.map.addControl(this.mapDrawTools);

    // Can't override these or the events don't fire to MapboxDraw custom modes - TODO figure out how to get events
    // https://github.com/mapbox/mapbox-gl-draw/blob/master/docs/API.md
    // this.map.on('draw.create', this.createdDrawArea);
    // this.map.on('draw.update', this.updatedDrawArea);

    this.map.addControl(new NavigationControl(), 'top-right');
  }

  public addedOrUpdatedPriorityZone(id, lat, lon, radiusInKm) {
    // TODO: Andy
  }

  public addPriorityZone(click: MapMouseEvent):void {
    if (click.lngLat) {
      new Marker({draggable: true})
        .setLngLat([click.lngLat.lng, click.lngLat.lat])
        .addTo(this.map);

        var json = {centerLongitude:click.lngLat.lng, centerLatitude:click.lngLat.lat};

        this.httpClient.post<any>("/priority-zone/create", json).subscribe(data => {

        });
    }
  }
}
