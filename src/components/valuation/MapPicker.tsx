import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, Marker, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";

// Fix default marker icons (Leaflet assumes assets on filesystem).
const markerIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

// Injects grab / grabbing cursor styles for the draggable marker.
const CURSOR_STYLE_ID = "leaflet-draggable-cursor";
function ensureCursorStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(CURSOR_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CURSOR_STYLE_ID;
  style.textContent = `
    .leaflet-marker-draggable { cursor: grab !important; }
    .leaflet-marker-draggable.leaflet-drag-target,
    .leaflet-dragging .leaflet-marker-draggable { cursor: grabbing !important; }
  `;
  document.head.appendChild(style);
}

function Recenter({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lng], map.getZoom(), { animate: true });
  }, [lat, lng, map]);
  return null;
}

export interface MapPickerProps {
  lat: number | null;
  lng: number | null;
  onChange: (lat: number, lng: number) => void;
}

// Default center: Ho Chi Minh City.
const DEFAULT_CENTER: [number, number] = [10.7769, 106.7009];

export function MapPicker({ lat, lng, onChange }: MapPickerProps) {
  const markerRef = useRef<L.Marker | null>(null);
  const center: [number, number] = useMemo(
    () => (lat !== null && lng !== null ? [lat, lng] : DEFAULT_CENTER),
    [lat, lng],
  );

  useEffect(() => {
    ensureCursorStyle();
  }, []);

  // If no coords yet, seed the parent with the default center on first mount
  // so the marker location is the source of truth.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    if (lat === null || lng === null) {
      seeded.current = true;
      onChange(DEFAULT_CENTER[0], DEFAULT_CENTER[1]);
    } else {
      seeded.current = true;
    }
  }, [lat, lng, onChange]);

  return (
    <MapContainer
      center={center}
      zoom={15}
      scrollWheelZoom
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Recenter lat={center[0]} lng={center[1]} />
      <Marker
        draggable
        position={center}
        icon={markerIcon}
        ref={(instance) => {
          markerRef.current = instance;
        }}
        eventHandlers={{
          dragend: () => {
            const m = markerRef.current;
            if (!m) return;
            const { lat: newLat, lng: newLng } = m.getLatLng();
            onChange(newLat, newLng);
          },
        }}
      />
    </MapContainer>
  );
}

export default MapPicker;