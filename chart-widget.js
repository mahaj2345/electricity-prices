// Data is published as a static JSON file to GitHub by the Apps Script
// trigger. raw.githubusercontent.com serves proper CORS headers, so a
// plain fetch() here is reliable — no JSONP or proxy workarounds needed.
const dataUrl =
  "https://raw.githubusercontent.com/mahaj2345/electricity-prices/main/prices.json";

const HOUR_MS = 60 * 60 * 1000;
const QUARTER_MS = 15 * 60 * 1000;

let allPrices = [];       // raw 15-minute prices, as fetched
let currentView = "hourly"; // "hourly" | "quarter"
let currentDay = "tanaan";  // "eilen" | "tanaan" | "huomenna"
let chartInstance = null;

async function fetchPrices() {
  const response = await fetch(dataUrl, { cache: "no-store" });
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }
  // API shape: { t: ["2026-09-02T00:00:00+03:00", ...], price: [0.1234, ...] }
  // Normalize back into the array-of-objects shape the rest of the code expects.
  return data.t.map((t, i) => ({ t, price: data.price[i] }));
}

// Collapse 15-minute prices into hourly averages. Grouping is done on
// the raw timestamp string prefix (year-month-dayThour) rather than via
// Date getters, so it's independent of the browser's own timezone.
// Missing quarters (price === null, from fillDayGaps) are excluded from
// the average; if an entire hour has no real data at all, the bucket's
// price is null too, so the bar is empty rather than showing a
// misleading average of zero real points.
function aggregateHourly(prices) {
  const buckets = new Map();
  prices.forEach((p) => {
    const key = p.t.slice(0, 13); // "YYYY-MM-DDTHH"
    if (!buckets.has(key)) {
      // Build the bucket's timestamp directly from the hour key itself
      // (always exactly HH:00:00), rather than reusing whichever
      // 15-minute sample happened to be first in the array for this
      // hour. The widened fetch window can return data as several
      // TimeSeries blocks (per day / per revision) that aren't always
      // in strict chronological order within the hour, so "the first
      // sample seen" isn't reliably the :00 one — that was silently
      // dropping the tick label for whichever hour got an out-of-order
      // sample first (its minutes weren't exactly 0).
      const offset = p.t.slice(19); // e.g. "+03:00"
      buckets.set(key, { sum: 0, count: 0, t: `${key}:00:00${offset}` });
    }
    const b = buckets.get(key);
    if (p.price !== null && p.price !== undefined) {
      b.sum += p.price;
      b.count += 1;
    }
  });
  return Array.from(buckets.values())
    .sort((a, b) => new Date(a.t) - new Date(b.t))
    .map((b) => ({ t: b.t, price: b.count > 0 ? b.sum / b.count : null }));
}

// The "current price" headline always reflects the real 15-min price,
// regardless of which view (hourly/quarter) or day is being shown.
function updateCurrentPriceDisplay(rawPrices) {
  const now = new Date();
  const current = rawPrices.find((p) => {
    const t = new Date(p.t);
    const next = new Date(t.getTime() + QUARTER_MS);
    return now >= t && now < next;
  });
  const el = document.getElementById("currentPrice");
  if (current) {
    const formatted = (current.price * 100).toLocaleString("fi-FI", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    el.textContent = `Sähkön hinta nyt: ${formatted} snt/kWh`;
  } else {
    el.textContent = "Sähkön hinta nyt: ei saatavilla";
  }
}

// --- Day selection (Eilen / Tänään / Huomenna) -----------------------

// Returns "YYYY-MM-DD" for a given Date, evaluated in Europe/Helsinki
// time. Using a fixed timezone (rather than the browser's local one)
// keeps "today" consistent no matter where the page is viewed from,
// matching the timezone the price data itself is published in.
function helsinkiDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// Date key for "today + offsetDays" (offsetDays can be negative),
// still evaluated against Europe/Helsinki's calendar date.
function dateKeyWithOffset(offsetDays) {
  const todayKey = helsinkiDateKey(new Date());
  const [y, m, d] = todayKey.split("-").map(Number);
  // Noon UTC avoids any DST-boundary edge cases when shifting by a day.
  const base = new Date(Date.UTC(y, m - 1, d, 12));
  base.setUTCDate(base.getUTCDate() + offsetDays);
  return helsinkiDateKey(base);
}

const DAY_OFFSETS = { eilen: -1, tanaan: 0, huomenna: 1 };

// A full day of 15-minute data has ~96 points (92/100 around DST
// changes). Before tomorrow's day-ahead prices are published (usually
// ~14:00), the feed still contains a single 00:00 entry for "tomorrow"
// — that's just the boundary marker at the end of today's data, not a
// real published price for that day. Treat anything at or below this
// threshold as "not published yet" rather than a real day of prices.
const MIN_POINTS_FOR_PUBLISHED_DAY = 4;

// Builds every expected 15-minute slot for a given calendar day
// ("YYYY-MM-DD"), filling in `price: null` for any slot missing from
// the fetched data. Without this, a missing quarter-hour (confirmed to
// happen occasionally on ENTSO-E's side) just means one fewer array
// entry — which silently compresses the chart, jumping straight to the
// next available time and closing up the gap instead of showing it.
// With every slot always present, Chart.js draws no bar for a null
// value but keeps its correct x-axis position, so a genuine gap in the
// data reads as an empty gap in the chart rather than a shifted one.
function fillDayGaps(dayPrices, dateKey) {
  const priceByTimestamp = new Map(dayPrices.map((p) => [p.t, p.price]));
  // Reuse whatever UTC offset the fetched data already has (it's
  // whatever Apps Script formatted for Europe/Helsinki, correctly
  // handling DST) — falls back to +02:00 in the unlikely case the
  // whole day is missing and there's nothing to read it from.
  const offset = dayPrices.length > 0 ? dayPrices[0].t.slice(19) : "+02:00";

  const filled = [];
  for (let hour = 0; hour < 24; hour++) {
    for (let minute = 0; minute < 60; minute += 15) {
      const hh = String(hour).padStart(2, "0");
      const mm = String(minute).padStart(2, "0");
      const t = `${dateKey}T${hh}:${mm}:00${offset}`;
      filled.push({
        t,
        price: priceByTimestamp.has(t) ? priceByTimestamp.get(t) : null,
      });
    }
  }
  return filled;
}

// Filters the full price list down to just the selected day, then fills
// in any missing 15-minute slots so gaps render as empty rather than
// being skipped over.
function getPricesForSelectedDay() {
  const targetKey = dateKeyWithOffset(DAY_OFFSETS[currentDay]);
  const dayPrices = allPrices.filter((p) => p.t.slice(0, 10) === targetKey);
  return fillDayGaps(dayPrices, targetKey);
}

// Wires up the Eilen/Tänään/Huomenna buttons already present in the
// page markup (see .day-toggle in index.html) — styling for these
// lives entirely in CSS (.day-toggle button / .day-toggle button.active)
// to match the existing .view-toggle look.
function setupDaySelector() {
  document.querySelectorAll(".day-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentDay = btn.dataset.dayKey;
      updateDaySelectorStyles();
      renderChart();
    });
  });
  updateDaySelectorStyles();
}

// Highlights whichever day button is currently active via the
// .active class (styling defined in CSS).
function updateDaySelectorStyles() {
  document.querySelectorAll(".day-toggle button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.dayKey === currentDay);
  });
}

// --- "No data for this day yet" message -------------------------------

// Creates a hidden message element right next to the canvas, shown
// instead of the chart when the selected day has no data (e.g. viewing
// "Huomenna" before tomorrow's day-ahead prices have been published).
function setupNoDataMessage() {
  const canvas = document.getElementById("priceChart");
  const msg = document.createElement("div");
  msg.id = "noDataMessage";
  msg.textContent = "Seuraavan päivän hinnat julkaistaan Nord Pool -sähköpörssissä noin klo 14:00. Hinnat päivittyvät sivustolle julkaisun jälkeen.";
  msg.style.display = "none";
  // Visual styling (padding/color/font-size) now lives in index.html's
  // <style> block under #noDataMessage — keeps this in sync with the
  // rest of the page's look without duplicating rules here.
  canvas.parentNode.insertBefore(msg, canvas.nextSibling);
}

function showNoDataMessage(show) {
  const canvas = document.getElementById("priceChart");
  const msg = document.getElementById("noDataMessage");
  if (!msg) return;
  msg.style.display = show ? "block" : "none";
  canvas.style.display = show ? "none" : "block";
}

// -----------------------------------------------------------------------

function drawChart(prices, bucketMs) {
  const ctx = document.getElementById("priceChart").getContext("2d");
  const now = new Date();
  // Slice "HH:MM" straight out of the ISO timestamp string rather than
  // going through Date + toLocaleTimeString. This gives a plain
  // colon-separated 24h time ("15:00" not "15.00", which is what
  // Finnish toLocaleTimeString produces), and — as a bonus — it's
  // immune to the viewer's own browser timezone, since the string
  // already encodes the correct Europe/Helsinki wall-clock time.
  const labels = prices.map((p) => p.t.slice(11, 16));
  // Keep null as null (not 0) for missing slots — Chart.js draws no bar
  // for a null value but still reserves its x-axis position, so a gap
  // in the data shows as an empty gap in the chart rather than a real
  // zero-price bar (which would misleadingly suggest free electricity).
  const values = prices.map((p) => (p.price !== null ? p.price * 100 : null));
  const colors = prices.map((p) => {
    if (p.price === null) return "#007bff"; // unused when value is null, but keep arrays aligned
    const t = new Date(p.t);
    const next = new Date(t.getTime() + bucketMs);
    return now >= t && now < next ? "#ff4d4d" : "#007bff";
  });

  if (chartInstance) {
    chartInstance.destroy();
  }

  chartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Sähkön hinta (snt/kWh)",
          data: values,
          backgroundColor: colors,
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Makes Chart.js's own internal number formatting (y-axis ticks,
      // tooltip values via ctx.formattedValue) use Finnish conventions
      // — a comma decimal separator instead of a period.
      locale: "fi-FI",
      scales: {
        x: {
          title: {
            display: true,
            text: "Aika",
            font: { size: 14 },
          },
          ticks: {
            maxRotation: 90,
            minRotation: 90,
            autoSkip: false, // we control which labels show ourselves, below
            callback: function (value, index) {
              // Read the hour/minute straight out of the timestamp
              // string (already Helsinki wall-clock time), not via
              // Date.getHours()/getMinutes() — those reflect the
              // *viewer's own browser timezone*, which would silently
              // shift which hours get labeled for anyone not in
              // Finland. Only label every 3rd full hour so labels
              // don't overlap across 2-3 days of bars.
              const hour = parseInt(prices[index].t.slice(11, 13), 10);
              const minute = prices[index].t.slice(14, 16);
              return minute === "00" && hour % 3 === 0 ? labels[index] : "";
            },
          },
        },
        y: {
          title: {
            display: true,
            text: "Hinta (snt/kWh)",
            font: { size: 14 },
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.formattedValue} snt/kWh`,
          },
        },
        title: {
          display: false,
          text: `Päivitetty: ${now.toLocaleString("fi-FI")}`,
          font: { size: 14 },
        },
      },
    },
  });
}

function renderChart() {
  const dayPrices = getPricesForSelectedDay();

  // dayPrices is now always a full 96-slot grid (see fillDayGaps), so
  // checking its length no longer tells us whether real data exists —
  // count actual (non-null) values instead.
  const publishedCount = dayPrices.filter((p) => p.price !== null).length;

  if (publishedCount <= MIN_POINTS_FOR_PUBLISHED_DAY) {
    if (chartInstance) {
      chartInstance.destroy();
      chartInstance = null;
    }
    showNoDataMessage(true);
    return;
  }

  showNoDataMessage(false);
  if (currentView === "hourly") {
    drawChart(aggregateHourly(dayPrices), HOUR_MS);
  } else {
    drawChart(dayPrices, QUARTER_MS);
  }
}

document.getElementById("toggleViewBtn").addEventListener("click", () => {
  currentView = currentView === "hourly" ? "quarter" : "hourly";
  document.getElementById("toggleViewBtn").textContent =
    currentView === "hourly" ? "15 min hinnat" : "Tuntihinnat";
  renderChart();
});

setupDaySelector();
setupNoDataMessage();

fetchPrices()
  .then((prices) => {
    allPrices = prices;
    updateCurrentPriceDisplay(allPrices);
    renderChart();
  })
  .catch((err) => {
    console.error("Virhe haettaessa dataa:", err);
  });