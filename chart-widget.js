const dataUrl =
  "https://raw.githubusercontent.com/mahaj2345/electricity-prices/main/prices.json";

const HOUR_MS = 60 * 60 * 1000;
const QUARTER_MS = 15 * 60 * 1000;

let allPrices = [];
let currentView = "hourly";
let chartInstance = null;

async function fetchPrices() {
  const response = await fetch(dataUrl, { cache: "no-store" });
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }
  return data.t.map((t, i) => ({ t, price: data.price[i] }));
}

function aggregateHourly(prices) {
  const buckets = new Map();
  prices.forEach((p) => {
    const key = p.t.slice(0, 13);
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

function drawChart(prices, bucketMs) {
  const ctx = document.getElementById("priceChart").getContext("2d");
  const now = new Date();
  const labels = prices.map((p) =>
    new Date(p.t).toLocaleTimeString("fi-FI", {
      hour: "2-digit",
      minute: "2-digit",
    })
  );
  const values = prices.map((p) => p.price * 100);
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
            autoSkip: false,
            callback: function (value, index) {
              const d = new Date(prices[index].t);
              if (d.getMinutes() !== 0 || d.getHours() % 3 !== 0) return "";

              const timeLabel = labels[index];
              const dateStr = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;

              if (!this._lastDateShown || this._lastDateShown !== dateStr) {
                this._lastDateShown = dateStr;
                return [timeLabel, dateStr];
              }
              return timeLabel;
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
