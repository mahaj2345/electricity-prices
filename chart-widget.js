// Data is published as a static JSON file to GitHub by the Apps Script
// trigger. raw.githubusercontent.com serves proper CORS headers, so a
// plain fetch() here is reliable — no JSONP or proxy workarounds needed.
const dataUrl =
  "https://raw.githubusercontent.com/mahaj2345/electricity-prices/main/prices.json";

const HOUR_MS = 60 * 60 * 1000;
const QUARTER_MS = 15 * 60 * 1000;

let allPrices = [];       // raw 15-minute prices, as fetched
let currentView = "hourly"; // "hourly" | "quarter"
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
function aggregateHourly(prices) {
  const buckets = new Map();
  prices.forEach((p) => {
    const key = p.t.slice(0, 13); // "YYYY-MM-DDTHH"
    if (!buckets.has(key)) {
      buckets.set(key, { sum: 0, count: 0, t: p.t });
    }
    const b = buckets.get(key);
    b.sum += p.price;
    b.count += 1;
  });
  return Array.from(buckets.values())
    .sort((a, b) => new Date(a.t) - new Date(b.t))
    .map((b) => ({ t: b.t, price: b.sum / b.count }));
}

// The "current price" headline always reflects the real 15-min price,
// regardless of which view (hourly/quarter) the chart is showing.
function updateCurrentPriceDisplay(rawPrices) {
  const now = new Date();
  const current = rawPrices.find((p) => {
    const t = new Date(p.t);
    const next = new Date(t.getTime() + QUARTER_MS);
    return now >= t && now < next;
  });
  const el = document.getElementById("currentPrice");
  if (current) {
    el.textContent = `Sähkön hinta nyt: ${(current.price * 100).toFixed(2)} snt/kWh`;
  } else {
    el.textContent = "Sähkön hinta nyt: ei saatavilla";
  }
}

// Format a Date as d.m.yyyy (no leading zeros), Finnish date convention.
function formatDate(d) {
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

function drawChart(prices, bucketMs) {
  const ctx = document.getElementById("priceChart").getContext("2d");
  const now = new Date();
  const labels = prices.map((p) =>
    new Date(p.t).toLocaleTimeString("fi-FI", {
      hour: "2-digit",
      minute: "2-digit",
    })
  );
  const values = prices.map((p) => p.price * 100); // €/kWh → snt/kWh
  const colors = prices.map((p) => {
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
              // Don't rely on the formatted label string (Finnish locale
              // uses "01.00" with a period, not "01:00"), check the
              // underlying timestamp directly instead. Only label every
              // 3rd full hour so labels don't overlap across 2-3 days
              // of bars.
              const d = new Date(prices[index].t);
              if (d.getMinutes() !== 0 || d.getHours() % 3 !== 0) {
                return "";
              }
              // At the midnight tick, add the date as a second line
              // below the time — this is the "secondary label" that
              // marks where each new day starts.
              if (d.getHours() === 0) {
                return [labels[index], formatDate(d)];
              }
              return labels[index];
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
  if (currentView === "hourly") {
    drawChart(aggregateHourly(allPrices), HOUR_MS);
  } else {
    drawChart(allPrices, QUARTER_MS);
  }
}

document.getElementById("toggleViewBtn").addEventListener("click", () => {
  currentView = currentView === "hourly" ? "quarter" : "hourly";
  document.getElementById("toggleViewBtn").textContent =
    currentView === "hourly" ? "15 min hinnat" : "Tuntihinnat";
  renderChart();
});

fetchPrices()
  .then((prices) => {
    allPrices = prices;
    updateCurrentPriceDisplay(allPrices);
    renderChart();
  })
  .catch((err) => {
    console.error("Virhe haettaessa dataa:", err);
  });
