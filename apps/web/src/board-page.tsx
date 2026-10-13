import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useCatchableDepartures } from "./catchable-departures";
import { departsAt, useNow } from "./departure-row";
import { textWidth, toGlyphs } from "./led-font";
import { STOPS } from "./stops";
import type { Departure } from "./trpc";

// 128 LEDs across like the two 64×32 panels, plus a 1-LED border, and as many
// LEDs tall as the screen allows. Each row of text is 9 LEDs, 11 apart; a
// Stop's header is 12, to fit the line under it, and Stops are 3 apart
const WIDTH = 130;
const LEFT = 1;
const RIGHT = WIDTH - 1;
const ROW_PITCH = 11;
const HEADER_PITCH = 12;
const STOP_GAP = 3;
// departures.getByStop returns at most 50
const MAX_ROWS_PER_STOP = 50;

const TEXT = "#f4f1ea";
const MUTED = "#7a7a7a";
const HEADER = "#ffb000";
const HEADER_LINE = "#4d3500";
const UNLIT = "#1a1a1a";
const ERROR = "#ff3b30";

const clockTime = new Intl.DateTimeFormat("en-IE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Dublin",
});

/**
 * The Departure Board's LEDs, drawn pixel by pixel and filling the screen: a
 * section per Stop of its catchable Departures, as many rows as fit
 */
export function BoardPage() {
  useFullScreenApp();
  const mainRef = useRef<HTMLElement>(null);
  const measured = useScreenSpace(mainRef);
  // Rows are worked out from the window until the board's space is measured,
  // but nothing is drawn, so the board doesn't jump on launch
  const viewport = measured?.safe ?? {
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const stopCount = STOPS.length;
  // Every Stop's header, the gaps between Stops, and the last row's unused 2
  const fixed = stopCount * HEADER_PITCH + (stopCount - 1) * STOP_GAP - 2;
  // LEDs are square, so the screen's shape sets how many fit down it, but
  // always room for a row per Stop and the border
  const height = Math.max(
    fixed + stopCount * ROW_PITCH + 2,
    Math.floor((viewport.height / viewport.width) * WIDTH),
  );
  // The rows are shared equally, any spare going to the first Stops
  const rows = Math.floor((height - 2 - fixed) / ROW_PITCH);
  const rowsPerStop = STOPS.map((_, index) =>
    Math.min(
      MAX_ROWS_PER_STOP,
      Math.floor(rows / stopCount) + (index < rows % stopCount ? 1 : 0),
    ),
  );

  const now = useNow();
  const { stops } = useCatchableDepartures({
    now,
    limit: Math.max(...rowsPerStop),
  });
  // Fast enough for the loading shimmer while any Stop is loading, else
  // just the realtime icon's 400 ms steps
  const loading = stops.some((s) => s.loading && s.departures.length === 0);
  const time = useClock(loading ? 50 : 400);

  const sections = stops.map((section, index) => ({
    ...section,
    departures: section.departures.slice(0, rowsPerStop[index]),
    rows: rowsPerStop[index] ?? 0,
  }));
  const pixels = createPixels(height);
  drawSections(pixels, sections, now, time);

  // What the board says, for screen readers
  const label = sections
    .map(
      ({ stop, departures }) =>
        `${stop.name}: ${
          departures
            .map(
              (d) =>
                `${d.routeShortName ?? d.routeId} ${d.headsign ?? ""} ${formatDue(d, now)}`,
            )
            .join(", ") || "no departures"
        }`,
    )
    .join(". ");

  return (
    <main
      ref={mainRef}
      // Pinned to the screen with no scrolling or zooming. The padding is only
      // measured: the safe area, clear of the notch and home indicator
      className="fixed inset-0 touch-none select-none overflow-hidden bg-[#050505] pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
    >
      {measured && <LedPanel pixels={pixels} space={measured} label={label} />}
    </main>
  );
}

/** One colour per LED, row by row; `null` is unlit */
type Pixels = { height: number; colors: (string | null)[] };

function createPixels(height: number): Pixels {
  return { height, colors: new Array(WIDTH * height).fill(null) };
}

type Section = {
  stop: { name: string };
  departures: Departure[];
  error: unknown;
  loading: boolean;
  rows: number;
};

/** Each Stop's header, then its Departures or why there are none */
function drawSections(
  pixels: Pixels,
  sections: Section[],
  now: Date,
  time: number,
) {
  const frame = Math.floor(time / 400) % 4;
  const used =
    sections.reduce(
      (sum, section) => sum + HEADER_PITCH + section.rows * ROW_PITCH,
      0,
    ) +
    (sections.length - 1) * STOP_GAP -
    2;
  // Headsigns line up across the board, after the widest route name
  const routeWidth = Math.max(
    0,
    ...sections.flatMap(({ departures }) =>
      departures.map((d) => textWidth(routeName(d))),
    ),
  );
  const headsignLeft = LEFT + (routeWidth || 11) + 4;

  // Centre the sections in whatever LEDs are left over
  let top = Math.floor((pixels.height - used) / 2);
  for (const [sectionIndex, section] of sections.entries()) {
    drawText(pixels, section.stop.name, LEFT, top, HEADER);
    for (let x = LEFT; x < RIGHT; x++) {
      setPixel(pixels, x, top + 10, HEADER_LINE);
    }
    top += HEADER_PITCH;

    if (section.departures.length === 0) {
      if (section.error) {
        drawText(pixels, "Error", LEFT, top, ERROR);
      } else if (section.loading) {
        for (let row = 0; row < section.rows; row++) {
          drawPlaceholderRow(pixels, {
            top: top + row * ROW_PITCH,
            headsignLeft,
            // Varied, but the same every frame
            headsignWidth:
              PLACEHOLDER_WIDTHS[(sectionIndex * 3 + row) % 6] ?? 0,
            time,
          });
        }
      } else {
        drawText(pixels, "No departures", LEFT, top, MUTED);
      }
    }
    section.departures.forEach((departure, index) => {
      drawDeparture(pixels, departure, {
        top: top + index * ROW_PITCH,
        headsignLeft,
        now,
        frame,
      });
    });
    top += section.rows * ROW_PITCH + STOP_GAP;
  }
}

function drawDeparture(
  pixels: Pixels,
  departure: Departure,
  {
    top,
    headsignLeft,
    now,
    frame,
  }: { top: number; headsignLeft: number; now: Date; frame: number },
) {
  const due = formatDue(departure, now);
  const dueLeft = RIGHT - textWidth(due);
  const realtime = departure.predictedDeparture !== null;
  const headsignRight = (realtime ? dueLeft - 7 : dueLeft) - 3;

  drawText(pixels, routeName(departure), LEFT, top, routeColor(departure));
  drawText(pixels, departure.headsign ?? "", headsignLeft, top, TEXT, {
    right: headsignRight,
  });
  if (realtime) drawRealtimeIcon(pixels, dueLeft - 7, top, frame);
  drawText(pixels, due, dueLeft, top, TEXT);
}

const PLACEHOLDER_WIDTHS = [46, 62, 38, 56, 50, 60];
const PLACEHOLDER_DIM = [62, 62, 62];
const PLACEHOLDER_BRIGHT = [200, 200, 200];
const SHIMMER_PERIOD_MS = 1600;
const SHIMMER_BAND = 14;

/**
 * Where a Departure will go while it loads: dim bars for its route,
 * headsign and time, with a bright band sweeping diagonally down the board
 */
function drawPlaceholderRow(
  pixels: Pixels,
  {
    top,
    headsignLeft,
    headsignWidth,
    time,
  }: { top: number; headsignLeft: number; headsignWidth: number; time: number },
) {
  const travel = WIDTH + pixels.height / 2 + SHIMMER_BAND * 2;
  const band =
    ((time % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS) * travel - SHIMMER_BAND;
  const bars: [number, number][] = [
    [LEFT, headsignLeft - 4],
    [headsignLeft, headsignLeft + headsignWidth],
    [RIGHT - 23, RIGHT],
  ];
  for (const [from, to] of bars) {
    for (let x = from; x < to; x++) {
      for (let y = top + 2; y <= top + 4; y++) {
        const distance = Math.abs(x + y / 2 - band);
        const glow = Math.max(0, 1 - distance / SHIMMER_BAND) ** 2;
        const [r, g, b] = PLACEHOLDER_DIM.map((dim, i) =>
          Math.round(dim + ((PLACEHOLDER_BRIGHT[i] ?? dim) - dim) * glow),
        );
        setPixel(pixels, x, y, `rgb(${r},${g},${b})`);
      }
    }
  }
}

function routeName(departure: Departure) {
  return departure.routeShortName ?? departure.routeId;
}

/** Draws whole glyphs from `left` until the next would pass `right` */
function drawText(
  pixels: Pixels,
  text: string,
  left: number,
  top: number,
  color: string,
  { right = RIGHT }: { right?: number } = {},
) {
  let x = left;
  for (const glyph of toGlyphs(text)) {
    if (x + glyph.width > right) return;
    glyph.rows.forEach((row, dy) => {
      row.forEach((lit, dx) => {
        if (lit) setPixel(pixels, x + dx, top + dy, color);
      });
    });
    x += glyph.width + 1;
  }
}

// A signal icon whose arcs light up in turn while a Departure is live
const REALTIME_ICON = [
  [2, 2, 2, 0, 0],
  [0, 0, 0, 2, 0],
  [1, 1, 0, 0, 2],
  [0, 0, 1, 0, 2],
  [3, 0, 1, 0, 2],
];
const REALTIME_DIM = "#3a3a3a";

function drawRealtimeIcon(
  pixels: Pixels,
  left: number,
  top: number,
  frame: number,
) {
  REALTIME_ICON.forEach((row, dy) => {
    row.forEach((part, dx) => {
      if (part === 0) return;
      // 3 is the dot, always lit; arcs 1 and 2 light from frames 1 and 2
      const lit = part === 3 || frame >= part;
      setPixel(pixels, left + dx, top + dy, lit ? TEXT : REALTIME_DIM);
    });
  });
}

function setPixel(pixels: Pixels, x: number, y: number, color: string) {
  if (x < 0 || x >= WIDTH || y < 0 || y >= pixels.height) return;
  pixels.colors[y * WIDTH + x] = color;
}

function routeColor(departure: Departure) {
  return departure.routeColor ? `#${departure.routeColor}` : TEXT;
}

function formatDue(departure: Departure, now: Date) {
  const departs = departsAt(departure);
  const dueMinutes = Math.floor((departs.getTime() - now.getTime()) / 60_000);
  if (dueMinutes <= 0) return "Now";
  if (dueMinutes < 60) return `${dueMinutes}min`;
  return clockTime.format(departs);
}

/**
 * Draws each pixel as a round LED with a soft glow. The board is as large as
 * fits the safe area, and unlit LEDs carry on to the screen's edges
 */
function LedPanel({
  pixels,
  space,
  label,
}: {
  pixels: Pixels;
  space: ScreenSpace;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { screen, safe } = space;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const scale = window.devicePixelRatio || 1;
    const width = Math.round(screen.width * scale);
    const height = Math.round(screen.height * scale);
    canvas.width = width;
    canvas.height = height;

    // The board, centred in the safe area, in device pixels
    const pitch =
      Math.min(safe.width / WIDTH, safe.height / pixels.height) * scale;
    const boardLeft =
      safe.left * scale + (safe.width * scale - WIDTH * pitch) / 2;
    const boardTop =
      safe.top * scale + (safe.height * scale - pixels.height * pitch) / 2;
    // Every LED on screen, counted from the board's top-left one
    const firstColumn = -Math.ceil(boardLeft / pitch);
    const lastColumn = Math.ceil((width - boardLeft) / pitch);
    const firstRow = -Math.ceil(boardTop / pitch);
    const lastRow = Math.ceil((height - boardTop) / pitch);

    const lit = document.createElement("canvas");
    lit.width = width;
    lit.height = height;
    const litContext = lit.getContext("2d");

    context.fillStyle = "#050505";
    context.fillRect(0, 0, width, height);
    for (let y = firstRow; y < lastRow; y++) {
      for (let x = firstColumn; x < lastColumn; x++) {
        const onBoard = x >= 0 && x < WIDTH && y >= 0 && y < pixels.height;
        const color = onBoard ? pixels.colors[y * WIDTH + x] : null;
        const target = color ? litContext : context;
        if (!target) continue;
        target.fillStyle = color ?? UNLIT;
        target.beginPath();
        target.arc(
          boardLeft + (x + 0.5) * pitch,
          boardTop + (y + 0.5) * pitch,
          pitch * (color ? 0.42 : 0.36),
          0,
          Math.PI * 2,
        );
        target.fill();
      }
    }

    // Glow first, then the sharp LEDs on top
    context.save();
    context.filter = `blur(${pitch * 0.8}px)`;
    context.globalAlpha = 0.7;
    context.globalCompositeOperation = "lighter";
    context.drawImage(lit, 0, 0);
    context.restore();
    context.drawImage(lit, 0, 0);
  }, [pixels, screen, safe]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={label}
      className="absolute inset-0 block h-full w-full"
    />
  );
}

/** The whole screen, and the safe area inside it, in CSS pixels */
type ScreenSpace = {
  screen: { width: number; height: number };
  safe: { left: number; top: number; width: number; height: number };
};

/**
 * `ref`'s size, and the safe area inside its padding, clear of the notch and
 * home indicator; `null` until it's measured, before the first paint
 */
function useScreenSpace(ref: RefObject<HTMLElement | null>) {
  const [space, setSpace] = useState<ScreenSpace | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const screen = {
        width: element.clientWidth,
        height: element.clientHeight,
      };
      const left = parseFloat(style.paddingLeft);
      const top = parseFloat(style.paddingTop);
      const safe = {
        left,
        top,
        width: screen.width - left - parseFloat(style.paddingRight),
        height: screen.height - top - parseFloat(style.paddingBottom),
      };
      if (safe.width <= 0 || safe.height <= 0) return;
      setSpace((current) =>
        current && JSON.stringify(current) === JSON.stringify({ screen, safe })
          ? current
          : { screen, safe },
      );
    };
    measure();
    // Safe areas and the window can settle after launch or on rotation
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return space;
}

/**
 * While the board is open: no page scroll or rubber-banding, and the tags iOS
 * reads when it's added to the Home Screen, so it opens full screen with the
 * board under a see-through status bar. Only this page sets them
 */
function useFullScreenApp() {
  useEffect(() => {
    const root = document.documentElement;
    const previous = {
      overflow: root.style.overflow,
      overscrollBehavior: root.style.overscrollBehavior,
      background: root.style.background,
    };
    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    root.style.background = "#050505";

    const added = [
      ["apple-mobile-web-app-capable", "yes"],
      ["mobile-web-app-capable", "yes"],
      ["apple-mobile-web-app-status-bar-style", "black-translucent"],
      ["apple-mobile-web-app-title", "Board"],
      ["theme-color", "#050505"],
    ].map(([name = "", content = ""]) => {
      const meta = document.createElement("meta");
      meta.name = name;
      meta.content = content;
      document.head.append(meta);
      return meta;
    });

    return () => {
      Object.assign(root.style, previous);
      for (const meta of added) meta.remove();
    };
  }, []);
}

/** Milliseconds since the page opened, updated every `intervalMs` */
function useClock(intervalMs: number) {
  const [time, setTime] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setTime(performance.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return time;
}
