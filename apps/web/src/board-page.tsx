import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { departsAt, useNow } from "./departure-row";
import { type Glyph, textWidth, toGlyphs } from "./led-font";
import { useStopDepartures } from "./stop-departures";
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
// A Departure due in this many minutes or fewer flashes amber
const DUE_SOON_MINUTES = 2;
const DUE_SOON = HEADER;

// Every redraw, fast enough for each LED step of a scrolling headsign
const TICK_MS = 50;
// Headsigns too long for their row pause, then scroll through and round again
const SCROLL_LEDS_PER_SECOND = 15;
const SCROLL_PAUSE_MS = 2500;
const SCROLL_GAP = 20;
// Rows slide to where they now belong, a changed due time rolls over, and a
// new row sweeps in from the left once the others have moved
const MOVE_MS = 450;
const ROLL_MS = 350;
const SWEEP_MS = 450;
// On a Stop's first Departures, each row sweeps in this long after the last
const SWEEP_STAGGER_MS = 90;

const clockTime = new Intl.DateTimeFormat("en-IE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Dublin",
});

/**
 * The Departure Board's LEDs, drawn pixel by pixel and filling the screen: a
 * section per Stop of its upcoming Departures, as many rows as fit
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
  // Every Departure from now, Walk Time or not, to check on the way
  const { stops } = useStopDepartures({
    now,
    limit: Math.max(...rowsPerStop),
    walkTime: false,
  });
  const [reducedMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [bootStart] = useState(() =>
    reducedMotion ? Number.NEGATIVE_INFINITY : performance.now(),
  );
  const [booting, setBooting] = useState(true);
  const time = useClock(TICK_MS);
  const bootElapsed = time - bootStart;
  useEffect(() => {
    if (booting && bootElapsed >= BOOT_MS) setBooting(false);
  }, [booting, bootElapsed]);

  const sections = stops.map((section, index) => ({
    ...section,
    departures: section.departures.slice(0, rowsPerStop[index]),
    rows: rowsPerStop[index] ?? 0,
  }));
  const motion = useRowMotion(sections, {
    now,
    time,
    enabled: !reducedMotion,
    firstSweepAt: bootStart + BOOT_MS,
  });
  const pixels = createPixels(height);
  drawSections(pixels, sections, {
    now,
    time,
    scroll: !reducedMotion,
    motion,
  });

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
      {measured && (
        <LedPanel
          pixels={pixels}
          space={measured}
          label={label}
          wipe={
            booting
              ? (x, y) => bootWipe(x, y, bootElapsed, pixels.height)
              : undefined
          }
        />
      )}
    </main>
  );
}

// The start-up test real LED signs run: each colour wipes diagonally across
// every LED, close behind the last, and then the board itself
const BOOT_COLORS = ["#ff2a1f", "#1fff4a", "#2a6bff", HEADER];
const WIPE_MS = 550;
const WIPE_STAGGER_MS = 170;
const BOOT_MS = BOOT_COLORS.length * WIPE_STAGGER_MS + WIPE_MS;
// LEDs past the board's edges, under the notch and so on, that the wipe covers
const WIPE_MARGIN = 24;

function bootWipe(x: number, y: number, elapsed: number, height: number) {
  // 0 at the top-left corner of the screen, 1 at the bottom-right
  const position =
    (x + y / 2 + WIPE_MARGIN * 1.5) / (WIDTH + height / 2 + WIPE_MARGIN * 3);
  let layer = -1;
  for (let k = 0; k <= BOOT_COLORS.length; k++) {
    if ((elapsed - k * WIPE_STAGGER_MS) / WIPE_MS >= position) layer = k;
  }
  if (layer === -1) return null;
  return BOOT_COLORS[layer];
}

/** Left and top are the first LEDs inside, right and bottom the first past */
type Bounds = { left: number; top: number; right: number; bottom: number };

/**
 * One colour per LED, row by row; `null` is unlit. Only LEDs inside `bounds`
 * are drawn
 */
type Pixels = { height: number; colors: (string | null)[]; bounds: Bounds };

function createPixels(height: number): Pixels {
  return {
    height,
    colors: new Array(WIDTH * height).fill(null),
    bounds: { left: 0, top: 0, right: WIDTH, bottom: height },
  };
}

/** Runs `draw` with only the LEDs inside both `bounds` and the current ones */
function withBounds(pixels: Pixels, bounds: Partial<Bounds>, draw: () => void) {
  const outer = pixels.bounds;
  pixels.bounds = {
    left: Math.max(outer.left, bounds.left ?? outer.left),
    top: Math.max(outer.top, bounds.top ?? outer.top),
    right: Math.min(outer.right, bounds.right ?? outer.right),
    bottom: Math.min(outer.bottom, bounds.bottom ?? outer.bottom),
  };
  draw();
  pixels.bounds = outer;
}

type Section = {
  stop: { stopId: string; name: string };
  departures: Departure[];
  error: unknown;
  loading: boolean;
  rows: number;
};

type Moment = {
  now: Date;
  /** Milliseconds since the page opened, for animation */
  time: number;
  /** Whether long headsigns scroll, or are cut short */
  scroll: boolean;
  /** How each row is moving, or `null` for no animation */
  motion: Map<string, RowMotion> | null;
};

/** A Departure's row as last drawn, and what of it is still animating */
type RowMotion = {
  index: number;
  due: string;
  /** Slides from the row position `from` to `index` */
  move?: { from: number; at: number };
  /** The due time rolls over from `from` */
  roll?: { from: string; at: number };
  /** Sweeps in from the left from this time */
  arrive?: number;
};

function departureKey(departure: Departure) {
  return `${departure.tripId}-${departure.stopId}-${departure.serviceDate}`;
}

/** 0 at `start`, easing out to 1 after `duration` */
function progress(time: number, start: number, duration: number) {
  const linear = Math.min(1, Math.max(0, (time - start) / duration));
  return 1 - (1 - linear) ** 3;
}

/** Where a row is now, in rows from its Stop's first, part way if moving */
function rowPosition(row: RowMotion, time: number) {
  if (!row.move) return row.index;
  const { from, at } = row.move;
  return from + (row.index - from) * progress(time, at, MOVE_MS);
}

/**
 * Each shown Departure's row, compared with the last frame's so a change
 * animates: a row that moves slides, a due time that changes rolls over, and
 * a new row sweeps in. Kept in a ref and updated as the board is drawn, so a
 * change animates from the frame it first shows; drawing the same frame again
 * changes nothing
 */
function useRowMotion(
  sections: Section[],
  {
    now,
    time,
    enabled,
    firstSweepAt,
  }: {
    now: Date;
    time: number;
    enabled: boolean;
    /** When a Stop's first rows can sweep in, so they're not under the boot */
    firstSweepAt: number;
  },
) {
  const rowsRef = useRef(new Map<string, RowMotion>());
  // Stops that have shown Departures, whose new rows wait for the rest to move
  const shownRef = useRef(new Set<string>());
  if (!enabled) return null;

  const rows = rowsRef.current;
  const present = new Set<string>();
  for (const { stop, departures } of sections) {
    const shown = shownRef.current.has(stop.stopId);
    departures.forEach((departure, index) => {
      const key = departureKey(departure);
      present.add(key);
      const due = formatDue(departure, now);
      const row = rows.get(key);
      if (!row) {
        rows.set(key, {
          index,
          due,
          arrive: shown
            ? time + MOVE_MS
            : Math.max(time, firstSweepAt) + index * SWEEP_STAGGER_MS,
        });
        return;
      }
      if (row.index !== index) {
        row.move = { from: rowPosition(row, time), at: time };
        row.index = index;
      }
      if (row.due !== due) {
        row.roll = { from: row.due, at: time };
        row.due = due;
      }
    });
    if (departures.length > 0) shownRef.current.add(stop.stopId);
  }
  for (const key of rows.keys()) {
    if (!present.has(key)) rows.delete(key);
  }
  return rows;
}

/** Each Stop's header, then its Departures or why there are none */
function drawSections(pixels: Pixels, sections: Section[], moment: Moment) {
  const { time } = moment;
  const frame = Math.floor(time / 400) % 4;
  const used =
    sections.reduce(
      (sum, section) => sum + HEADER_PITCH + section.rows * ROW_PITCH,
      0,
    ) +
    (sections.length - 1) * STOP_GAP -
    2;
  // Centre the sections in whatever LEDs are left over
  let top = Math.floor((pixels.height - used) / 2);
  for (const [sectionIndex, section] of sections.entries()) {
    drawText(pixels, section.stop.name, LEFT, top, HEADER);
    for (let x = LEFT; x < RIGHT; x++) {
      setPixel(pixels, x, top + 10, HEADER_LINE);
    }
    top += HEADER_PITCH;

    // A Stop's headsigns line up after its widest route name
    const routeWidth = Math.max(
      0,
      ...section.departures.map((d) => textWidth(routeName(d))),
    );
    const headsignLeft = LEFT + (routeWidth || 11) + 4;

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
    // Rows only draw in their Stop's own rows, so one sliding past is cut off
    const rowsBounds = {
      top,
      bottom: top + section.rows * ROW_PITCH - 2,
    };
    section.departures.forEach((departure, index) => {
      const row = moment.motion?.get(departureKey(departure));
      const rowTop =
        top + Math.round((row ? rowPosition(row, time) : index) * ROW_PITCH);
      const sweep =
        row?.arrive === undefined ? 1 : progress(time, row.arrive, SWEEP_MS);
      if (sweep <= 0) return;
      const sweepRight = Math.round(sweep * WIDTH);
      withBounds(pixels, { ...rowsBounds, right: sweepRight }, () => {
        drawDeparture(pixels, departure, {
          top: rowTop,
          headsignLeft,
          moment,
          frame,
          roll: row?.roll,
        });
      });
      if (sweep < 1) {
        // A scan line leads the sweep across the row
        withBounds(pixels, rowsBounds, () => {
          for (let y = rowTop - 1; y < rowTop + 10; y++) {
            setPixel(pixels, sweepRight, y, HEADER);
          }
        });
      }
    });
    top += section.rows * ROW_PITCH + STOP_GAP;
  }
}

/**
 * A Departure's route, headsign and when it's due. Its due time flashes
 * amber once it's only minutes away, like the signs on the platform
 */
function drawDeparture(
  pixels: Pixels,
  departure: Departure,
  {
    top,
    headsignLeft,
    moment: { now, time, scroll },
    frame,
    roll,
  }: {
    top: number;
    headsignLeft: number;
    moment: Moment;
    frame: number;
    roll?: RowMotion["roll"];
  },
) {
  const due = formatDue(departure, now);
  const dueLeft = RIGHT - textWidth(due);
  const realtime = departure.predictedDeparture !== null;
  const iconLeft = dueLeft - 7;
  const headsignRight = (realtime ? iconLeft : dueLeft) - 3;
  const dueSoon =
    Math.floor((departsAt(departure).getTime() - now.getTime()) / 60_000) <=
    DUE_SOON_MINUTES;

  drawText(pixels, routeName(departure), LEFT, top, routeColor(departure));
  const headsign = departure.headsign ?? "";
  if (scroll) {
    drawScrollingText(pixels, headsign, headsignLeft, top, TEXT, {
      right: headsignRight,
      time,
    });
  } else {
    drawText(pixels, headsign, headsignLeft, top, TEXT, {
      right: headsignRight,
    });
  }
  if (realtime) drawRealtimeIcon(pixels, iconLeft, top, frame);
  if (!dueSoon || time % 1000 < 600) {
    drawDue(pixels, due, top, dueSoon ? DUE_SOON : TEXT, {
      roll: roll && {
        from: roll.from,
        progress: progress(time, roll.at, ROLL_MS),
      },
    });
  }
}

/** Each glyph of `text` right-aligned to the board's edge, and where it is */
function layoutRight(text: string) {
  let x = RIGHT - textWidth(text);
  const chars = [...text];
  return toGlyphs(text).map((glyph, index) => {
    const placed = { glyph, x, key: `${chars[index]}@${x}` };
    x += glyph.width + 1;
    return placed;
  });
}

/**
 * The due time at the board's right edge. While it rolls over, glyphs that
 * changed roll up and out as the new ones roll up from below; the rest stay
 */
function drawDue(
  pixels: Pixels,
  due: string,
  top: number,
  color: string,
  { roll }: { roll?: { from: string; progress: number } },
) {
  if (!roll || roll.progress >= 1) {
    drawText(pixels, due, RIGHT - textWidth(due), top, color);
    return;
  }
  const before = layoutRight(roll.from);
  const after = layoutRight(due);
  const staying = new Set(
    before
      .filter(({ key }) => after.some((placed) => placed.key === key))
      .map(({ key }) => key),
  );
  const shift = Math.round(roll.progress * ROW_PITCH);
  withBounds(pixels, { top, bottom: top + 9 }, () => {
    for (const { glyph, x, key } of after) {
      const rise = staying.has(key) ? 0 : ROW_PITCH - shift;
      drawGlyph(pixels, glyph, x, top + rise, color);
    }
    for (const { glyph, x, key } of before) {
      if (!staying.has(key)) drawGlyph(pixels, glyph, x, top - shift, color);
    }
  });
}

/**
 * Text that fits is drawn as it is. Text too long for `left` to `right`
 * waits, scrolls left until it comes round again, and repeats
 */
function drawScrollingText(
  pixels: Pixels,
  text: string,
  left: number,
  top: number,
  color: string,
  { right, time }: { right: number; time: number },
) {
  const width = textWidth(text);
  if (left + width <= right) {
    drawText(pixels, text, left, top, color, { right });
    return;
  }
  const cycle = width + SCROLL_GAP;
  const scrollMs = (cycle / SCROLL_LEDS_PER_SECOND) * 1000;
  const elapsed = (time % (SCROLL_PAUSE_MS + scrollMs)) - SCROLL_PAUSE_MS;
  const offset = Math.floor(
    (Math.max(0, elapsed) * SCROLL_LEDS_PER_SECOND) / 1000,
  );
  const clip = { left, right };
  drawText(pixels, text, left - offset, top, color, { clip });
  drawText(pixels, text, left - offset + cycle, top, color, { clip });
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

/**
 * Draws whole glyphs from `left` until the next would pass `right`, or with
 * `clip`, every LED between its edges, glyphs cut where they cross them
 */
function drawText(
  pixels: Pixels,
  text: string,
  left: number,
  top: number,
  color: string,
  {
    right = RIGHT,
    clip,
  }: { right?: number; clip?: { left: number; right: number } } = {},
) {
  let x = left;
  for (const glyph of toGlyphs(text)) {
    if (clip ? x >= clip.right : x + glyph.width > right) return;
    if (clip) {
      withBounds(pixels, clip, () => drawGlyph(pixels, glyph, x, top, color));
    } else {
      drawGlyph(pixels, glyph, x, top, color);
    }
    x += glyph.width + 1;
  }
}

function drawGlyph(
  pixels: Pixels,
  glyph: Glyph,
  left: number,
  top: number,
  color: string,
) {
  glyph.rows.forEach((row, dy) => {
    row.forEach((lit, dx) => {
      if (lit) setPixel(pixels, left + dx, top + dy, color);
    });
  });
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
  const { left, top, right, bottom } = pixels.bounds;
  if (x < left || x >= right || y < top || y >= bottom) return;
  pixels.colors[y * WIDTH + x] = color;
}

/**
 * The route's colour as a lit LED shows it: scaled up until its brightest
 * channel is full, so dark brand colours glow instead of fading into the board
 */
function routeColor(departure: Departure) {
  const hex = departure.routeColor ?? "";
  const channels = [0, 2, 4].map((i) =>
    Number.parseInt(hex.slice(i, i + 2), 16),
  );
  const brightest = Math.max(...channels);
  // Not a colour, or too near black to light up
  if (!(brightest >= 32)) return TEXT;
  const [r, g, b] = channels.map((c) => Math.round((c * 255) / brightest));
  return `rgb(${r},${g},${b})`;
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
  wipe,
}: {
  pixels: Pixels;
  space: ScreenSpace;
  label: string;
  /** A colour to show instead, `null` for unlit, `undefined` for the board */
  wipe?: (x: number, y: number) => string | null | undefined;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Reused between frames: the lit LEDs, before their glow is added
  const litRef = useRef<HTMLCanvasElement>(null);
  // Every unlit LED, which only changes with the screen
  const backgroundRef = useRef<{
    geometry: string;
    canvas: HTMLCanvasElement;
  }>(null);
  // What's on screen, so a frame that changes no LED isn't drawn again
  const drawnRef = useRef<{
    geometry: string;
    colors: (string | null)[];
  }>(null);
  const { screen, safe } = space;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const scale = window.devicePixelRatio || 1;
    const width = Math.round(screen.width * scale);
    const height = Math.round(screen.height * scale);

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

    const geometry = [width, height, pitch, boardLeft, boardTop].join();
    const drawn = drawnRef.current;
    if (
      !wipe &&
      drawn?.geometry === geometry &&
      sameColors(drawn.colors, pixels.colors)
    ) {
      return;
    }
    drawnRef.current = wipe ? null : { geometry, colors: pixels.colors };

    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    litRef.current ??= document.createElement("canvas");
    const lit = litRef.current;
    if (lit.width !== width) lit.width = width;
    if (lit.height !== height) lit.height = height;
    const litContext = lit.getContext("2d");
    if (!litContext) return;
    litContext.clearRect(0, 0, width, height);

    const drawLed = (
      target: CanvasRenderingContext2D,
      x: number,
      y: number,
      color: string | null,
    ) => {
      target.fillStyle = color ?? UNLIT;
      target.globalAlpha = ledBrightness(x, y);
      target.beginPath();
      target.arc(
        boardLeft + (x + 0.5) * pitch,
        boardTop + (y + 0.5) * pitch,
        pitch * (color ? 0.42 : 0.36),
        0,
        Math.PI * 2,
      );
      target.fill();
    };

    context.globalAlpha = 1;
    if (wipe) {
      // The wipe covers LEDs past the board's edges too, so all are drawn
      context.fillStyle = "#050505";
      context.fillRect(0, 0, width, height);
      for (let y = firstRow; y < lastRow; y++) {
        for (let x = firstColumn; x < lastColumn; x++) {
          const onBoard = x >= 0 && x < WIDTH && y >= 0 && y < pixels.height;
          const override = wipe(x, y);
          const color =
            override !== undefined
              ? override
              : onBoard
                ? pixels.colors[y * WIDTH + x]
                : null;
          drawLed(color ? litContext : context, x, y, color ?? null);
        }
      }
    } else {
      if (backgroundRef.current?.geometry !== geometry) {
        const background = document.createElement("canvas");
        background.width = width;
        background.height = height;
        const backgroundContext = background.getContext("2d");
        if (!backgroundContext) return;
        backgroundContext.fillStyle = "#050505";
        backgroundContext.fillRect(0, 0, width, height);
        for (let y = firstRow; y < lastRow; y++) {
          for (let x = firstColumn; x < lastColumn; x++) {
            drawLed(backgroundContext, x, y, null);
          }
        }
        backgroundRef.current = { geometry, canvas: background };
      }
      context.drawImage(backgroundRef.current.canvas, 0, 0);
      // Lit LEDs are larger, so each covers the unlit one under it
      for (let y = 0; y < pixels.height; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const color = pixels.colors[y * WIDTH + x];
          if (color) drawLed(litContext, x, y, color);
        }
      }
    }

    // drawLed leaves each LED's own brightness set
    context.globalAlpha = 1;
    // Glow first, then the sharp LEDs on top
    context.save();
    context.filter = `blur(${pitch * 0.8}px)`;
    context.globalAlpha = 0.7;
    context.globalCompositeOperation = "lighter";
    context.drawImage(lit, 0, 0);
    context.restore();
    context.drawImage(lit, 0, 0);
  }, [pixels, screen, safe, wipe]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={label}
      className="absolute inset-0 block h-full w-full"
    />
  );
}

/**
 * Each LED's own brightness, from 84% to full: real LEDs never quite match,
 * and the same LED always looks the same, so it's a hash of where it is
 */
function ledBrightness(x: number, y: number) {
  let hash = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return 0.84 + (((hash ^ (hash >>> 16)) >>> 0) / 2 ** 32) * 0.16;
}

function sameColors(a: (string | null)[], b: (string | null)[]) {
  return a.length === b.length && a.every((color, index) => color === b[index]);
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
 * reads when it's added to the Home Screen, so it opens full screen below a
 * black status bar. Only this page sets them
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
      // Not black-translucent: under a see-through status bar, iOS draws the
      // page from the top of the screen but cuts it off a status bar short
      ["apple-mobile-web-app-status-bar-style", "black"],
      ["apple-mobile-web-app-title", "Go"],
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
