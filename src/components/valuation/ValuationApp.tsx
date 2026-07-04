import { useEffect, useMemo, useRef, useState } from "react";
import { Building2, MapPin, Type, Loader2, Sparkles, TrendingUp, TrendingDown, Home, Ruler, Layers, DoorOpen, Bath, BedDouble, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

type LocationMode = "text" | "pin";

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
}

type GeoStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; lat: number; lon: number; display: string }
  | { kind: "error"; message: string };

const VND = (v: number) => {
  if (v >= 1_000_000_000)
    return `${(v / 1_000_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} tỷ`;
  if (v >= 1_000_000)
    return `${(v / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} triệu`;
  return v.toLocaleString("vi-VN");
};

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
  const total = Number(data?.valuation?.total_price_vnd ?? 0);
  const unit = Number(data?.valuation?.unit_price_vnd ?? 0);
  const score = Math.round(Number(data?.spatial_insights?.score_100 ?? 0));
  const shapley = data?.shapley ?? {};
  const shap: ShapFactor[] = [
    { label: "Diện tích", impact: Math.round(Number(shapley.area ?? 0) * 100) / 100 },
    { label: "Vị trí không gian", impact: Math.round(Number(shapley.spatial ?? 0) * 100) / 100 },
  ].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));

  return { total, unit, score, shap };
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

  // Debounced geocoding via OpenStreetMap Nominatim
  const geocodeSeq = useRef(0);
  useEffect(() => {
    if (locMode !== "text") return;
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
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`Geocoding ${res.status}`);
        const arr = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
        if (seq !== geocodeSeq.current) return;
        if (!arr.length) {
          setGeo({ kind: "error", message: "Không tìm thấy toạ độ cho địa chỉ này" });
          setForm((f) => ({ ...f, lat: null, lng: null }));
          return;
        }
        const lat = parseFloat(arr[0].lat);
        const lon = parseFloat(arr[0].lon);
        setGeo({ kind: "success", lat, lon, display: arr[0].display_name });
        setForm((f) => ({ ...f, lat, lng: lon }));
      } catch (e) {
        if (seq !== geocodeSeq.current) return;
        setGeo({ kind: "error", message: (e as Error).message || "Lỗi mã hoá địa chỉ" });
        setForm((f) => ({ ...f, lat: null, lng: null }));
      }
    }, 600);
    return () => clearTimeout(t);
  }, [form.address, locMode]);

  const valid = useMemo(() => {
    return (
      form.area >= 10 &&
      form.area <= 500 &&
      form.floors >= 1 &&
      form.floors <= 20 &&
      form.frontage >= 1 &&
      form.frontage <= 50 &&
      form.roadWidth >= 1 &&
      form.roadWidth <= 120 &&
      form.lat !== null &&
      form.lng !== null
    );
  }, [form, locMode]);

  const handleValuate = async () => {
    if (!valid || form.lat === null || form.lng === null) {
      toast.error("Chưa đủ dữ liệu", { description: "Vui lòng nhập địa chỉ hợp lệ để lấy toạ độ." });
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
      toast.success("Định giá thành công");
      // scroll to result on mobile
      setTimeout(() => {
        document.getElementById("valuation-output")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    } catch (e) {
      const msg = (e as Error).message || "Không thể kết nối máy chủ định giá";
      toast.error("Định giá thất bại", { description: msg });
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
                  Đang phân tích dữ liệu…
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-5 w-5" />
                  ĐỊNH GIÁ NGAY
                </>
              )}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Dữ liệu bảo mật · Sử dụng mô hình định giá AI kết hợp giao dịch thực tế
            </p>
          </section>

          {/* Column 2 — Output */}
          <section id="valuation-output" className="min-w-0">
            {result ? (
              <ResultDashboard result={result} />
            ) : (
              <EmptyState loading={loading} />
            )}
          </section>
        </div>
      </main>
      <footer className="border-t border-border bg-card/50 py-6">
        <div className="mx-auto max-w-[1400px] px-4 text-center text-xs text-muted-foreground sm:px-6 lg:px-8">
          © 2026 PropValue AI · Mô hình định giá phục vụ mục đích tham khảo trong hoạt động ngân hàng và bất động sản
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
            <div className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Real Estate Valuation</div>
          </div>
        </div>
        <div className="hidden items-center gap-6 sm:flex">
          <a className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground" href="#">Định giá</a>
          <a className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground" href="#">Báo cáo</a>
          <a className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground" href="#">API</a>
          <Badge className="border-success/30 bg-success/10 text-success hover:bg-success/15" variant="outline">
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
        Định giá tài sản theo thời gian thực
      </Badge>
      <h1 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
        Xác định giá trị chính xác cho bất động sản của bạn
      </h1>
      <p className="mt-3 text-base text-muted-foreground">
        Mô hình học máy phân tích hơn 40 yếu tố về vị trí, hạ tầng và giao dịch tương đồng để đưa ra khoảng giá tin cậy cho mục đích thế chấp, mua bán và đầu tư.
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
}: {
  mode: LocationMode;
  setMode: (m: LocationMode) => void;
  address: string;
  onAddress: (v: string) => void;
  lat: number | null;
  lng: number | null;
  geo: GeoStatus;
}) {
  return (
    <Card className="border-border/60 p-5 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-primary/10 text-primary">
            <MapPin className="h-4 w-4" />
          </div>
          <h2 className="text-base font-semibold text-foreground">Vị trí tài sản</h2>
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
            Địa chỉ
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
            Ghim bản đồ
          </button>
        </div>
      </div>

      {mode === "text" ? (
        <div className="space-y-2">
          <Label htmlFor="address" className="text-xs font-medium text-muted-foreground">
            Địa chỉ đầy đủ
          </Label>
          <Input
            id="address"
            value={address}
            onChange={(e) => onAddress(e.target.value)}
            placeholder="Số nhà, đường, phường/xã, quận/huyện, tỉnh/thành phố"
            className="h-11 border-border bg-background"
          />
          <GeoIndicator geo={geo} />
        </div>
      ) : (
        <MapPlaceholder lat={lat ?? 0} lng={lng ?? 0} label="Kéo ghim để chọn vị trí chính xác" />
      )}
    </Card>
  );
}

function GeoIndicator({ geo }: { geo: GeoStatus }) {
  if (geo.kind === "idle") {
    return (
      <p className="text-[11px] text-muted-foreground">
        Nhập địa chỉ để tự động lấy toạ độ (OpenStreetMap).
      </p>
    );
  }
  if (geo.kind === "loading") {
    return (
      <p className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Đang tra cứu toạ độ…
      </p>
    );
  }
  if (geo.kind === "success") {
    return (
      <div className="rounded-md border border-success/30 bg-success/10 px-2.5 py-1.5 text-[11px] text-success">
        <div className="flex items-center gap-1.5 font-medium">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Đã tìm thấy toạ độ · {geo.lat.toFixed(5)}, {geo.lon.toFixed(5)}
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
        <h2 className="text-base font-semibold text-foreground">Đặc điểm tài sản</h2>
      </div>

      <div className="space-y-6">
        {/* Area */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Ruler className="h-3.5 w-3.5" /> Diện tích (m²)
            </Label>
            <NumberInline
              value={form.area}
              min={10}
              max={500}
              onChange={(v) => update("area", v)}
              suffix="m²"
            />
          </div>
          <Slider
            value={[form.area]}
            min={10}
            max={500}
            step={1}
            onValueChange={([v]) => update("area", v)}
          />
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>10</span>
            <span>500 m²</span>
          </div>
        </div>

        <Separator />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <NumField
            label="Số tầng"
            icon={<Layers className="h-3.5 w-3.5" />}
            value={form.floors}
            min={1}
            max={20}
            onChange={(v) => update("floors", v)}
          />
          <NumField
            label="Mặt tiền (m)"
            icon={<DoorOpen className="h-3.5 w-3.5" />}
            value={form.frontage}
            min={1}
            max={50}
            step={0.5}
            onChange={(v) => update("frontage", v)}
          />
          <NumField
            label="Đường trước (m)"
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
            label="Phòng ngủ"
            icon={<BedDouble className="h-3.5 w-3.5" />}
            value={form.bedrooms}
            min={0}
            max={15}
            onChange={(v) => update("bedrooms", v)}
          />
          <Stepper
            label="Phòng tắm"
            icon={<Bath className="h-3.5 w-3.5" />}
            value={form.bathrooms}
            min={0}
            max={15}
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
          aria-label={`Giảm ${label}`}
        >
          −
        </button>
        <span className="text-lg font-bold tabular-nums text-foreground">{value}</span>
        <button
          type="button"
          onClick={() => onChange(clamp(value + 1, min, max))}
          className="grid h-8 w-8 place-items-center rounded-md text-lg font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          disabled={value >= max}
          aria-label={`Tăng ${label}`}
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
        {loading ? "Đang phân tích bất động sản…" : "Kết quả định giá sẽ hiển thị tại đây"}
      </h3>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {loading
          ? "Hệ thống đang so sánh với hàng nghìn giao dịch gần đây, tính toán điểm vị trí và các yếu tố ảnh hưởng."
          : "Điền thông tin tài sản ở cột bên trái và nhấn “Định giá tài sản” để nhận báo cáo chi tiết bao gồm giá trị thương mại, điểm không gian, phân tích SHAP và giao dịch tương đồng."}
      </p>
      {!loading && (
        <div className="mt-6 grid w-full max-w-md grid-cols-2 gap-3">
          {[
            { k: "Giá trị thương mại", v: "Total & Unit" },
            { k: "Điểm vị trí", v: "0 – 100" },
            { k: "Giải thích AI", v: "SHAP factors" },
            { k: "Comparable Sales", v: "15 lân cận" },
          ].map((it) => (
            <div key={it.k} className="rounded-lg border border-border bg-background/60 p-3 text-left">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{it.k}</div>
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
            Tổng giá trị tài sản
          </div>
        </div>

        <div className="mt-3 flex items-end gap-3">
          <div className="text-5xl font-black leading-none tracking-tight sm:text-6xl">
            {VND(result.total)}
          </div>
          <div className="pb-2 text-sm text-primary-foreground/70">VNĐ</div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-primary-foreground/85">
          <div>
            <span className="text-primary-foreground/60">Đơn giá: </span>
            <span className="font-semibold">{VND(result.unit)} VNĐ/m²</span>
          </div>
          <div className="font-mono text-xs text-primary-foreground/60">
            {result.total.toLocaleString("vi-VN")} ₫
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
  const dash = (score / 100) * c;
  const good = score > 70;
  const message = good
    ? "Vị trí đắc địa, hưởng lợi lớn từ tiện ích xung quanh."
    : score > 45
    ? "Vị trí tốt, thuận tiện cho sinh hoạt và giao thương."
    : "Vị trí bình thường, tiềm năng khai thác vừa phải.";
  const color = good ? "var(--success)" : score > 45 ? "var(--primary-glow)" : "var(--warning)";
  return (
    <Card className="border-border/60 p-6 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Điểm không gian (Spatial Premium)</h3>
          <p className="text-xs text-muted-foreground">Tiện ích, hạ tầng, kết nối giao thông</p>
        </div>
        {good && (
          <Badge className="border-success/30 bg-success/10 text-success" variant="outline">
            Đắc địa
          </Badge>
        )}
      </div>

      <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} className="-rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="var(--muted)"
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
              strokeDasharray={`${dash} ${c}`}
              style={{ transition: "stroke-dasharray 0.9s cubic-bezier(0.4,0,0.2,1)" }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-4xl font-black tabular-nums text-foreground">{score}</div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">/ 100</div>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-foreground">{message}</p>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-2 text-center">
        {[
          { k: "Trường học", v: "8" },
          { k: "Bệnh viện", v: "3" },
          { k: "Trung tâm TM", v: "5" },
        ].map((s) => (
          <div key={s.k} className="rounded-md bg-slate-surface p-2">
            <div className="text-lg font-bold text-foreground">{s.v}</div>
            <div className="text-[10px] text-muted-foreground">{s.k}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ShapCard({ shap }: { shap: ShapFactor[] }) {
  const data = shap.map((s) => ({ ...s, absImpact: Math.abs(s.impact) }));
  const max = Math.max(...data.map((d) => d.absImpact), 5);
  return (
    <Card className="border-border/60 p-6 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Yếu tố ảnh hưởng giá (SHAP)</h3>
          <p className="text-xs text-muted-foreground">Đóng góp của từng đặc trưng vào giá trị</p>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-success" /> Tăng</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-destructive" /> Giảm</span>
        </div>
      </div>

      <div className="space-y-2.5">
        {data.map((f) => {
          const positive = f.impact >= 0;
          const width = (f.absImpact / max) * 100;
          return (
            <div key={f.label} className="grid grid-cols-[minmax(0,120px)_1fr_auto] items-center gap-3">
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
                  } transition-[width] duration-700`}
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