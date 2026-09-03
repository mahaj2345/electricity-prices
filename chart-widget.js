const labels = [];
let previousDate = null;

prices.forEach((p) => {
  const dateKey = p.t.slice(0, 10); // YYYY-MM-DD
  const [year, month, day] = dateKey.split("-");

  const timeLabel = new Date(p.t).toLocaleTimeString("fi-FI", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const dateLabel = `${Number(day)}.${Number(month)}.${year}`;

  labels.push(
    dateKey !== previousDate
      ? [timeLabel, dateLabel]
      : timeLabel
  );

  previousDate = dateKey;
});
