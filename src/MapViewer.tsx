import React, { useState, useEffect } from 'react';
import MapGL, { NavigationControl } from 'react-map-gl/maplibre';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer } from '@deck.gl/layers';
import 'maplibre-gl/dist/maplibre-gl.css';

interface Vehicle {
  id: number;
  x: number;
  y: number;
  angle: number;
  vitesse: number;
}

interface MapViewerProps {
  vehicles: Vehicle[];
  initialLongitude?: number;
  initialLatitude?: number;
  initialZoom?: number;
}

export const MapViewer: React.FC<MapViewerProps> = ({
  vehicles,
  initialLongitude = 7.5,
  initialLatitude = 48.3,
  initialZoom = 11,
}) => {
  const [viewState, setViewState] = useState({
    longitude: initialLongitude,
    latitude: initialLatitude,
    zoom: initialZoom,
    pitch: 0,
    bearing: 0,
  });

  const [hasCentered, setHasCentered] = useState(false);

  //ce hook s'active des que la liste des vehicules change
  useEffect(() => {
    if (!hasCentered && vehicles.length > 0) {
      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;

      for (const v of vehicles) {
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
      }

      //on calcule le centre de tous les véhicules
      const centerLon = (minX + maxX) / 2;
      const centerLat = (minY + maxY) / 2;

      //on met à jour la caméra
      setViewState(prev => ({
        ...prev,
        longitude: centerLon,
        latitude: centerLat
      }));
      
      setHasCentered(true);
    }
  }, [vehicles, hasCentered]);

  const mapStyle = {
    version: 8 as const,
    sources: {
      osm: {
        type: 'raster' as const,
        tiles: ['https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
      },
    },
    layers: [
      {
        id: 'osm',
        type: 'raster' as const,
        source: 'osm',
      },
    ],
  };

  const layers = [
    new ScatterplotLayer({
      id: 'vehicle-layer',
      data: vehicles,
      pickable: true,
      opacity: 0.9,
      radiusScale: 2.2,
      radiusMinPixels: 3,
      radiusMaxPixels: 14,
      getPosition: (d: Vehicle) => {
        //lon et lat pour Deck.gl
        return [d.x, d.y];
      },
      getRadius: 3,
      getFillColor: (d: Vehicle) => {
        //couleur selon la vitesse
        const speed = Math.min(d.vitesse, 100);
        return [255 - (speed * 2), speed * 2, 0, 200];
      },
      getLineColor: [0, 0, 0, 255],
      lineWidthMinPixels: 1,
      onHover: (info: any) => {
        if (info.object) {
          console.log(`Voiture ${info.object.id}: vitesse ${info.object.vitesse} km/h`);
        }
      },
      updateTriggers: {
        getFillColor: [vehicles],
      },
      transitions: {
        getPosition: {
          duration: 220,
          easing: (t: number) => t
        }
      }
    }),
  ];

  const handleMapContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const handleMapMouseUp = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button === 2) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onContextMenu={handleMapContextMenu}
      onMouseUp={handleMapMouseUp}
    >
      <DeckGL
        initialViewState={viewState}
        controller={true}
        layers={layers}
        onViewStateChange={(e: { viewState: typeof viewState }) => setViewState(e.viewState)}
        style={{ width: '100%', height: '100%' }}
      >
        <MapGL
          {...viewState}
          onMove={(evt) => setViewState(evt.viewState)}
          mapStyle={mapStyle}
          attributionControl={true}
        >
          <NavigationControl position="top-left" />
          <div
            style={{
              position: 'absolute',
              bottom: 10,
              left: 10,
              background: 'rgba(255, 255, 255, 0.8)',
              padding: '8px 12px',
              borderRadius: '4px',
              fontSize: '12px',
              zIndex: 10,
            }}
          >
            © OpenStreetMap contributors
          </div>
        </MapGL>
      </DeckGL>

      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          background: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          padding: '12px',
          borderRadius: '4px',
          fontSize: '12px',
          zIndex: 10,
          minWidth: '200px',
        }}
      >
        <div>Zoom: {Math.round(viewState.zoom * 10) / 10}</div>
        <div>Voitures visibles: {vehicles.length}</div>
        {vehicles.length > 0 && (
          <div>
            Vitesse moy:{' '}
            {Math.round(
              vehicles.reduce((acc, v) => acc + v.vitesse, 0) / vehicles.length
            )}{' '}
            km/h
          </div>
        )}
      </div>
    </div>
  );
};