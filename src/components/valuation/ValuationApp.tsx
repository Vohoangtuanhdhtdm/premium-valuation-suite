import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  MapPin,
  Type,
  Loader2,
  Sparkles,
  TrendingUp,
  TrendingDown,
  Home,
  Ruler,
  Layers,
  DoorOpen,
  Bath,
  BedDouble,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

type LocationMode = "text" | "pin";

// Client-only Leaflet map (Leaflet touches `window` at import time).
const MapPicker = lazy(() =>
  import("./MapPicker").then((m) => ({ default: m.MapPicker })),
);

interface FormState {
  address: string;
  lat: number | null;
  lng: number | null;
  area: number;
  floors: number;
  frontage: number;
  roadWidth: number;
  bedrooms: number;
  bathrooms: number;
}

interface ShapFactor {
  label: string;
  impact: number; // percent, +/-
}

interface ValuationResult {
  total: number; // VND
  unit: number; // VND / m²
  score: number; // 0-100
  shap: ShapFactor[];
  status: "success" | "warning";
  message?: string;
}

type GeoStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; lat: number; lon: number; display: string }
  | { kind: "error"; message: string };

function VND(amount: number) {
  // Hàm format tiền tệ VNĐ hiển thị rút gọn (tỷ, triệu)
  if (amount >= 1e9) {
    return (amount / 1e9).toFixed(2).replace(/\.00$/, "") + " tỷ";
  }
  if (amount >= 1e6) {
    return (amount / 1e6).toFixed(1).replace(/\.0$/, "") + " triệu";
  }
  return amount.toLocaleString("vi-VN");
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

const VALUATION_ENDPOINT = "http://localhost:8000/api/v1/valuate";

async function callValuationAPI(input: {
  lat: number;
  lon: number;
  area: number;
  floors: number;
  frontage: number;
  road_width: number;
  bedrooms: number;
  bathrooms: number;
}): Promise<ValuationResult> {
  const res = await fetch(VALUATION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    if (res.status === 422) {
      const err = new Error(
        "Dữ liệu cấu trúc hoặc tọa độ vượt quá giới hạn phân tích của hệ thống.",
      );
      (err as any).code = 422;
      throw err;
    }
    let detail = `${res.status} ${res.statusText}`;
    try {
      const err = await res.json();
      if (err?.detail) {
        detail = typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
      }
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }

  const data = await res.json();
  const status: "success" | "warning" = data?.status === "warning" ? "warning" : "success";
  const message: string | undefined =
    typeof data?.message === "string" ? data.message : undefined;
  const total = Number(data?.valuation?.total_price_vnd ?? 0);
  const unit = Number(data?.valuation?.unit_price_vnd ?? 0);
  const score = Math.round(Number(data?.spatial_insights?.score_100 ?? 0));

  // Xử lý luồng SHAP động từ Backend
  const shapleyData = Array.isArray(data?.shapley) ? data.shapley : [];

  const shap: ShapFactor[] = shapleyData
    .map((item: any) => ({
      label: item.label,
      impact: Math.round(Number(item.impact) * 100) / 100, // Làm tròn 2 chữ số thập phân
    }))
    // Tùy chọn: Chỉ hiển thị các yếu tố có sức ảnh hưởng đáng kể (trị tuyệt đối >= 1%)
    // để tránh biểu đồ bị nhiễu bởi các thanh quá nhỏ
    .filter((item: ShapFactor) => Math.abs(item.impact) >= 1.0)
    // Sắp xếp các thanh đồ thị từ yếu tố tác động mạnh nhất đến yếu nhất
    .sort((a: ShapFactor, b: ShapFactor) => Math.abs(b.impact) - Math.abs(a.impact));

  return { total, unit, score, shap, status, message };
}

function normalizeAddress(input: string): string {
  return input
    .replace(/\b(HCMC|TP\.?\s*HCM|TPHCM)\b/gi, "Ho Chi Minh City")
    .replace(/\bDistrict\s+([0-9]+|[A-Za-z]+)\b/gi, "Quận $1")
    .replace(/\bWard\s+([0-9]+|[A-Za-z]+)\b/gi, "Phường $1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function nominatimSearch(
  q: string,
): Promise<Array<{ lat: string; lon: string; display_name: string }>> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ", Vietnam")}&format=json&limit=1`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Geocoding ${res.status}`);
  return (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
}

async function nominatimReverse(lat: number, lon: number): Promise<string | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=18&addressdetails=1`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = (await res.json()) as { display_name?: string };
  return data.display_name ?? null;
}

export function ValuationApp() {
  const [locMode, setLocMode] = useState<LocationMode>("text");
  const [form, setForm] = useState<FormState>({
    address: "",
    lat: null,
    lng: null,
    area: 80,
    floors: 4,
    frontage: 5,
    roadWidth: 8,
    bedrooms: 3,
    bathrooms: 3,
  });
  const [geo, setGeo] = useState<GeoStatus>({ kind: "idle" });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ValuationResult | null>(null);

  const update = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Ignore address→geocode effect for the next address change (used after
  // reverse-geocoding a dragged pin, so we don't fight the user's chosen coords).
  const skipNextGeocode = useRef(false);

  const handlePinDrag = async (newLat: number, newLng: number) => {
    setForm((f) => ({ ...f, lat: newLat, lng: newLng }));
    setGeo({ kind: "loading" });
    try {
      const display = await nominatimReverse(newLat, newLng);
      if (display) {
        skipNextGeocode.current = true;
        setForm((f) => ({ ...f, address: display, lat: newLat, lng: newLng }));
        setGeo({ kind: "success", lat: newLat, lon: newLng, display });
      } else {
        setGeo({
          kind: "success",
          lat: newLat,
          lon: newLng,
          display: `${newLat.toFixed(5)}, ${newLng.toFixed(5)}`,
        });
      }
    } catch {
      setGeo({
        kind: "success",
        lat: newLat,
        lon: newLng,
        display: `${newLat.toFixed(5)}, ${newLng.toFixed(5)}`,
      });
    }
  };

  // Debounced geocoding via OpenStreetMap Nominatim
  const geocodeSeq = useRef(0);
  useEffect(() => {
    if (locMode !== "text") return;
    if (skipNextGeocode.current) {
      skipNextGeocode.current = false;
      return;
    }
    const q = form.address.trim();
    if (q.length < 4) {
      setGeo({ kind: "idle" });
      setForm((f) => (f.lat === null && f.lng === null ? f : { ...f, lat: null, lng: null }));
      return;
    }
    const seq = ++geocodeSeq.current;
    setGeo({ kind: "loading" });
    const t = setTimeout(async () => {
      try {
        // Attempt 1 — raw query + ", Vietnam"
        let arr = await nominatimSearch(q);
        if (seq !== geocodeSeq.current) return;

        // Attempt 2 — normalized (English → Vietnamese) fallback
        if (!arr.length) {
          const normalized = normalizeAddress(q);
          if (
            normalized &&
            normalized.toLowerCase() !== q.toLowerCase() &&
            normalized.length >= 3
          ) {
            arr = await nominatimSearch(normalized);
            if (seq !== geocodeSeq.current) return;
          }
        }

        if (!arr.length) {
          setGeo({ kind: "error", message: "Unable to locate address. Please use Map Pin." });
          setForm((f) => ({ ...f, lat: null, lng: null }));
          return;
        }

        const lat = parseFloat(arr[0].lat);
        const lon = parseFloat(arr[0].lon);
        setGeo({ kind: "success", lat, lon, display: arr[0].display_name });
        setForm((f) => ({ ...f, lat, lng: lon }));
      } catch (e) {
        if (seq !== geocodeSeq.current) return;
        setGeo({ kind: "error", message: "Unable to locate address. Please use Map Pin." });
        setForm((f) => ({ ...f, lat: null, lng: null }));
      }
    }, 600);
    return () => clearTimeout(t);
  }, [form.address, locMode]);

  const valid = useMemo(() => {
    return (
      form.area >= 10 &&
      form.area <= 1000 &&
      form.floors >= 1 &&
      form.floors <= 20 &&
      form.frontage >= 1 &&
      form.frontage <= 50 &&
      form.roadWidth >= 1 &&
      form.roadWidth <= 120 &&
      form.bedrooms >= 1 &&
      form.bedrooms <= 30 &&
      form.bathrooms >= 1 &&
      form.bathrooms <= 30 &&
      form.lat !== null &&
      form.lng !== null
    );
  }, [form, locMode]);

  const handleValuate = async () => {
    if (!valid || form.lat === null || form.lng === null) {
      toast.error("Missing data", {
        description: "Please enter a valid address to resolve coordinates.",
      });
      return;
    }
    setLoading(true);
    try {
      const r = await callValuationAPI({
        lat: form.lat,
        lon: form.lng,
        area: form.area,
        floors: form.floors,
        frontage: form.frontage,
        road_width: form.roadWidth,
        bedrooms: form.bedrooms,
        bathrooms: form.bathrooms,
      });
      setResult(r);
      toast.success("Valuation completed");
      // scroll to result on mobile
      setTimeout(() => {
        document
          .getElementById("valuation-output")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    } catch (e) {
      const err = e as Error & { code?: number };
      if (err.code === 422) {
        toast.error(err.message);
      } else {
        toast.error("Valuation failed", {
          description: err.message || "Could not reach the valuation service",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[image:var(--gradient-hero)]">
      <TopNav />
      <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        <Header />
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)] lg:gap-8">
          {/* Column 1 — Input */}
          <section className="space-y-6">
            <LocationCard
              mode={locMode}
              setMode={setLocMode}
              address={form.address}
              onAddress={(v) => update("address", v)}
              lat={form.lat}
              lng={form.lng}
              geo={geo}
              onPinChange={handlePinDrag}
            />
            <AttributesCard form={form} update={update} />
            <Button
              size="lg"
              onClick={handleValuate}
              disabled={!valid || loading}
              className="h-14 w-full rounded-xl bg-[image:var(--gradient-primary)] text-base font-semibold tracking-wide text-primary-foreground shadow-[var(--shadow-elevated)] transition-[var(--transition-smooth)] hover:opacity-95 hover:shadow-[var(--shadow-glow)] disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Analyzing data…
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-5 w-5" />
                  VALUATE PROPERTY
                </>
              )}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Secure data · AI valuation model powered by real transaction records
            </p>
          </section>

          {/* Column 2 — Output */}
          <section id="valuation-output" className="min-w-0">
            {result ? <ResultDashboard result={result} /> : <EmptyState loading={loading} />}
          </section>
        </div>
      </main>
      <footer className="border-t border-border bg-card/50 py-6">
        <div className="mx-auto max-w-[1400px] px-4 text-center text-xs text-muted-foreground sm:px-6 lg:px-8">
          © 2026 PropValue AI · Valuation model provided for reference in banking and real estate
          use cases
        </div>
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header + Nav                                                               */
/* -------------------------------------------------------------------------- */

function TopNav() {
  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-[image:var(--gradient-primary)] shadow-[var(--shadow-glow)]">
            <Building2 className="h-5 w-5 text-primary-foreground" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold tracking-tight text-foreground">PropValue AI</div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">
              Real Estate Valuation
            </div>
          </div>
        </div>
        <div className="hidden items-center gap-6 sm:flex">
          <a
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            href="#"
          >
            Valuation
          </a>
          <a
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            href="#"
          >
            Reports
          </a>
          <a
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            href="#"
          >
            API
          </a>
          <Badge
            className="border-success/30 bg-success/10 text-success hover:bg-success/15"
            variant="outline"
          >
            <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
            Model v3.2 · Live
          </Badge>
        </div>
      </div>
    </header>
  );
}

function Header() {
  return (
    <div className="max-w-3xl">
      <Badge variant="outline" className="mb-3 border-primary/20 bg-primary/5 text-primary">
        Real-time Property Valuation
      </Badge>
      <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
        Accurate Property Valuation
      </h1>
      <p className="mt-3 text-base text-muted-foreground">
        Our machine learning model analyzes over 40 spatial and structural features — location,
        infrastructure, and comparable transactions — to produce a trusted price range for mortgage,
        sale, and investment decisions.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Column 1 — Location                                                        */
/* -------------------------------------------------------------------------- */

function LocationCard({
  mode,
  setMode,
  address,
  onAddress,
  lat,
  lng,
  geo,
  onPinChange,
}: {
  mode: LocationMode;
  setMode: (m: LocationMode) => void;
  address: string;
  onAddress: (v: string) => void;
  lat: number | null;
  lng: number | null;
  geo: GeoStatus;
  onPinChange: (lat: number, lng: number) => void;
}) {
  return (
    <Card className="border-border/60 p-5 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
            <MapPin className="h-4 w-4" />
          </div>
          <h2 className="text-base font-semibold text-foreground">Property Location</h2>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-muted p-0.5">
          <button
            onClick={() => setMode("text")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-[var(--transition-smooth)] ${
              mode === "text"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Type className="h-3.5 w-3.5" />
            Address
          </button>
          <button
            onClick={() => setMode("pin")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-[var(--transition-smooth)] ${
              mode === "pin"
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <MapPin className="h-3.5 w-3.5" />
            Map Pin
          </button>
        </div>
      </div>

      {mode === "text" ? (
        <div className="space-y-2">
          <Label htmlFor="address" className="text-xs font-medium text-muted-foreground">
            Full Address
          </Label>
          <Input
            id="address"
            value={address}
            onChange={(e) => onAddress(e.target.value)}
            placeholder="Street number, street, ward, district, city"
            className="h-11 border-border bg-background"
          />
          <GeoIndicator geo={geo} />
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative h-72 w-full overflow-hidden rounded-lg border border-border bg-slate-surface">
            <Suspense
              fallback={
                <div className="grid h-full w-full place-items-center text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading map…
                  </span>
                </div>
              }
            >
              <MapPicker lat={lat} lng={lng} onChange={onPinChange} />
            </Suspense>
            <div className="pointer-events-none absolute bottom-2 left-2 z-[400] rounded-md bg-card/95 px-2 py-1 font-mono text-[10px] text-muted-foreground shadow-sm ring-1 ring-border">
              {(lat ?? 0).toFixed(5)}, {(lng ?? 0).toFixed(5)}
            </div>
            <div className="pointer-events-none absolute bottom-2 right-2 z-[400] rounded-md bg-card/95 px-2 py-1 text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-border">
              Drag the pin to set exact location
            </div>
          </div>
          <GeoIndicator geo={geo} />
        </div>
      )}
    </Card>
  );
}

function GeoIndicator({ geo }: { geo: GeoStatus }) {
  if (geo.kind === "idle") {
    return (
      <p className="text-[11px] text-muted-foreground">
        Enter an address to auto-resolve coordinates (OpenStreetMap).
      </p>
    );
  }
  if (geo.kind === "loading") {
    return (
      <p className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Resolving coordinates…
      </p>
    );
  }
  if (geo.kind === "success") {
    return (
      <div className="rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-[11px] text-success">
        <div className="flex items-center gap-1.5 font-medium">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Coordinates found · {geo.lat.toFixed(5)}, {geo.lon.toFixed(5)}
        </div>
        <div className="mt-0.5 truncate text-[10px] text-success/80">{geo.display}</div>
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11px] font-medium text-destructive">
      <AlertCircle className="h-3.5 w-3.5" />
      {geo.message}
    </div>
  );
}

function MapPlaceholder({
  lat,
  lng,
  label,
  points,
}: {
  lat: number;
  lng: number;
  label?: string;
  points?: { x: number; y: number; primary?: boolean }[];
}) {
  const cells = Array.from({ length: 12 * 8 });
  const generated = useMemo(
    () =>
      points ??
      Array.from({ length: 15 }).map(() => ({
        x: 10 + Math.random() * 80,
        y: 12 + Math.random() * 76,
      })),
    [points],
  );
  return (
    <div className="relative h-56 w-full overflow-hidden rounded-lg border border-border bg-slate-surface">
      <div className="absolute inset-0 grid grid-cols-12 grid-rows-8">
        {cells.map((_, i) => (
          <div key={i} className="border border-border/50" />
        ))}
      </div>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,oklch(0.97_0.008_250/0.9))]" />
      {/* comp points */}
      {generated.map((p, i) => (
        <div
          key={i}
          className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/40 ring-2 ring-primary/10"
          style={{ left: `${p.x}%`, top: `${p.y}%` }}
        />
      ))}
      {/* primary pin */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full">
        <div className="relative">
          <div className="absolute inset-0 -z-10 animate-ping rounded-full bg-primary/30" />
          <div className="grid h-8 w-8 place-items-center rounded-full bg-[image:var(--gradient-primary)] shadow-[var(--shadow-glow)]">
            <MapPin className="h-4 w-4 text-primary-foreground" />
          </div>
        </div>
      </div>
      <div className="absolute bottom-2 left-2 rounded-md bg-card/95 px-2 py-1 text-[10px] font-mono text-muted-foreground shadow-sm ring-1 ring-border">
        {lat.toFixed(4)}, {lng.toFixed(4)}
      </div>
      {label && (
        <div className="absolute bottom-2 right-2 rounded-md bg-card/95 px-2 py-1 text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-border">
          {label}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Column 1 — Attributes                                                      */
/* -------------------------------------------------------------------------- */

function AttributesCard({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  return (
    <Card className="border-border/60 p-5 shadow-[var(--shadow-card)]">
      <div className="mb-5 flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
          <Home className="h-4 w-4" />
        </div>
        <h2 className="text-base font-semibold text-foreground">Property Characteristics</h2>
      </div>

      <div className="space-y-6">
        {/* Area */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Ruler className="h-3.5 w-3.5" /> Area (m²)
            </Label>
            <NumberInline
              value={form.area}
              min={10}
              max={1000}
              onChange={(v) => update("area", v)}
              suffix="m²"
            />
          </div>
          <Slider
            value={[form.area]}
            min={10}
            max={1000}
            step={1}
            onValueChange={([v]) => update("area", v)}
          />
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>10</span>
            <span>1000 m²</span>
          </div>
        </div>

        <Separator />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumField
            label="Floors"
            icon={<Layers className="h-3.5 w-3.5" />}
            value={form.floors}
            min={1}
            max={20}
            onChange={(v) => update("floors", v)}
          />
          <NumField
            label="Frontage (m)"
            icon={<DoorOpen className="h-3.5 w-3.5" />}
            value={form.frontage}
            min={1}
            max={50}
            step={0.5}
            onChange={(v) => update("frontage", v)}
          />
          <NumField
            label="Road Width (m)"
            icon={<Ruler className="h-3.5 w-3.5" />}
            value={form.roadWidth}
            min={1}
            max={120}
            step={0.5}
            onChange={(v) => update("roadWidth", v)}
          />
        </div>

        <Separator />

        <div className="grid grid-cols-2 gap-4">
          <Stepper
            label="Bedrooms"
            icon={<BedDouble className="h-3.5 w-3.5" />}
            value={form.bedrooms}
            min={1}
            max={30}
            onChange={(v) => update("bedrooms", v)}
          />
          <Stepper
            label="Bathrooms"
            icon={<Bath className="h-3.5 w-3.5" />}
            value={form.bathrooms}
            min={1}
            max={30}
            onChange={(v) => update("bathrooms", v)}
          />
        </div>
      </div>
    </Card>
  );
}

function NumberInline({
  value,
  min,
  max,
  onChange,
  suffix,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(clamp(Number(e.target.value || 0), min, max))}
        className="w-14 bg-transparent text-right text-sm font-semibold tabular-nums text-foreground outline-none"
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function NumField({
  label,
  icon,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <Label className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon} {label}
      </Label>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value || 0), min, max))}
        className="h-10 border-border bg-background font-semibold tabular-nums"
      />
      <div className="mt-1 text-[10px] text-muted-foreground">
        {min} – {max}
      </div>
    </div>
  );
}

function Stepper({
  label,
  icon,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <Label className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon} {label}
      </Label>
      <div className="flex items-center justify-between rounded-lg border border-border bg-background p-1">
        <button
          type="button"
          onClick={() => onChange(clamp(value - 1, min, max))}
          className="grid h-8 w-8 place-items-center rounded-md text-lg font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          disabled={value <= min}
          aria-label={`Decrease ${label}`}
        >
          −
        </button>
        <span className="text-lg font-bold tabular-nums text-foreground">{value}</span>
        <button
          type="button"
          onClick={() => onChange(clamp(value + 1, min, max))}
          className="grid h-8 w-8 place-items-center rounded-md text-lg font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          disabled={value >= max}
          aria-label={`Increase ${label}`}
        >
          +
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Column 2 — Output                                                          */
/* -------------------------------------------------------------------------- */

function EmptyState({ loading }: { loading: boolean }) {
  return (
    <Card className="flex h-full min-h-[560px] flex-col items-center justify-center border-dashed border-border/70 bg-card/60 p-8 text-center shadow-[var(--shadow-card)]">
      <div className="relative">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-[image:var(--gradient-primary)] shadow-[var(--shadow-glow)]">
          {loading ? (
            <Loader2 className="h-7 w-7 animate-spin text-primary-foreground" />
          ) : (
            <Building2 className="h-7 w-7 text-primary-foreground" />
          )}
        </div>
      </div>
      <h3 className="mt-5 text-lg font-semibold text-foreground">
        {loading ? "Analyzing property…" : "Valuation results will appear here"}
      </h3>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {loading
          ? "Comparing against thousands of recent transactions, scoring location, and computing feature impact."
          : "Fill in the property details on the left and click “Valuate Property” to receive a detailed report including market value, spatial score, SHAP analysis, and comparable transactions."}
      </p>
      {!loading && (
        <div className="mt-6 grid w-full max-w-md grid-cols-2 gap-3">
          {[
            { k: "Market Value", v: "Total & Unit" },
            { k: "Location Score", v: "0 – 100" },
            { k: "AI Explainability", v: "SHAP factors" },
            { k: "Comparable Sales", v: "15 nearby" },
          ].map((it) => (
            <div
              key={it.k}
              className="rounded-lg border border-border bg-background/60 p-3 text-left"
            >
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {it.k}
              </div>
              <div className="mt-0.5 text-sm font-semibold text-foreground">{it.v}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ResultDashboard({ result }: { result: ValuationResult }) {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <CommercialValueCard result={result} />
      <SpatialScoreCard score={result.score} />
      <div className="md:col-span-2">
        <ShapCard shap={result.shap} />
      </div>
    </div>
  );
}

function CommercialValueCard({ result }: { result: ValuationResult }) {
  return (
    <Card className="relative overflow-hidden border-transparent bg-[image:var(--gradient-value)] p-6 text-primary-foreground shadow-[var(--shadow-elevated)] md:col-span-2">
      <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary-glow/30 blur-3xl" />
      <div className="relative">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-primary-foreground/70">
            <TrendingUp className="h-3.5 w-3.5" />
            Estimated Total Value
          </div>
        </div>

        <div className="mt-3 flex items-end gap-3">
          <div className="text-5xl font-black leading-none tracking-tight sm:text-6xl">
            {VND(result.total)}
          </div>
          <div className="pb-2 text-sm text-primary-foreground/70">VND</div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-primary-foreground/85">
          <div>
            <span className="text-primary-foreground/60">Unit Price: </span>
            <span className="font-semibold">{VND(result.unit)} VND/m²</span>
          </div>
          <div className="font-mono text-xs text-primary-foreground/60">
            {result.total.toLocaleString("en-US")} ₫
          </div>
        </div>
      </div>
    </Card>
  );
}

function SpatialScoreCard({ score }: { score: number }) {
  const size = 148;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  // Sử dụng state để quản lý animation từ 0 chạy lên giá trị thực tế
  const [animatedScore, setAnimatedScore] = useState(0);

  useEffect(() => {
    // Delay nhẹ 100ms để đảm bảo CSS transition được kích hoạt sau khi component mount
    const timer = setTimeout(() => {
      setAnimatedScore(score || 0);
    }, 100);
    return () => clearTimeout(timer);
  }, [score]);

  // Sử dụng strokeDashoffset thay vì Dasharray để animation mượt mà chuẩn xác
  const dashoffset = c - (animatedScore / 100) * c;

  const good = animatedScore > 70;
  const message = good
    ? "Prime location with strong benefit from surrounding amenities."
    : animatedScore > 45
      ? "Good location, convenient for daily life and commerce."
      : "Average location with moderate development potential.";

  // Màu sắc fallback nếu CSS variable chưa load kịp
  const color = good
    ? "var(--success, #10b981)"
    : animatedScore > 45
      ? "var(--primary-glow, #3b82f6)"
      : "var(--warning, #f59e0b)";

  return (
    <Card className="border-border/60 p-6 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Spatial Premium Score</h3>
          <p className="text-xs text-muted-foreground">
            Amenities, infrastructure, and transport connectivity
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} className="-rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="var(--muted, #e2e8f0)"
              strokeWidth={stroke}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={dashoffset}
              style={{
                transition: "stroke-dashoffset 1.5s cubic-bezier(0.4,0,0.2,1), stroke 1.5s ease",
              }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-4xl font-black tabular-nums text-foreground">{animatedScore}</div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">/ 100</div>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-foreground">{message}</p>
      </div>
    </Card>
  );
}

function ShapCard({ shap }: { shap: ShapFactor[] }) {
  // Phòng ngừa trường hợp mảng shap bị rỗng hoặc lỗi từ backend
  if (!shap || shap.length === 0) return null;

  const data = shap.map((s) => ({ ...s, absImpact: Math.abs(s.impact) }));
  const max = Math.max(...data.map((d) => d.absImpact), 5);

  return (
    <Card className="border-border/60 p-6 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Price Impact Factors (SHAP)</h3>
          <p className="text-xs text-muted-foreground">
            Contribution of each feature to the final value
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-success" /> Increase
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-destructive" /> Decrease
          </span>
        </div>
      </div>

      <div className="space-y-2.5">
        {data.map((f) => {
          const positive = f.impact >= 0;
          const width = (f.absImpact / max) * 100;
          return (
            <div
              key={f.label}
              className="grid grid-cols-[minmax(0,120px)_1fr_auto] items-center gap-3"
            >
              <div className="truncate text-xs font-medium text-foreground">
                {positive ? (
                  <TrendingUp className="mr-1 inline h-3 w-3 text-success" />
                ) : (
                  <TrendingDown className="mr-1 inline h-3 w-3 text-destructive" />
                )}
                {f.label}
              </div>
              <div className="relative h-6 rounded-md bg-slate-surface">
                <div
                  className={`absolute inset-y-0 left-0 rounded-md ${
                    positive ? "bg-success/85" : "bg-destructive/85"
                  } transition-[width] duration-700 ease-out`}
                  style={{ width: `${width}%` }}
                />
              </div>
              <div
                className={`w-14 text-right text-xs font-bold tabular-nums ${
                  positive ? "text-success" : "text-destructive"
                }`}
              >
                {positive ? "+" : ""}
                {f.impact}%
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
