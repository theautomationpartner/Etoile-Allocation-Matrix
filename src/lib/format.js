// §7.2 — thousands separator, "28 Sep" in headers, "28 Sep 2026" in text.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const fmt = (v) => (v || 0).toLocaleString("en-US");
export const plural = (count, one, many) => `${fmt(count)} ${count === 1 ? one : many}`;
export const clock = (d) => d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

const parse = (s) => new Date(`${s}T12:00:00`);
export const dayMonth = (s) => (s ? `${parse(s).getDate()} ${MON[parse(s).getMonth()]}` : "");
export const dayMonthYear = (s) => (s ? `${dayMonth(s)} ${parse(s).getFullYear()}` : "");
