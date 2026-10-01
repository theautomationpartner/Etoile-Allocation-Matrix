const PATHS = {
  grid: "M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9",
  table: "M2 3h12v10H2zM2 6.5h12M6.5 6.5V13M10.5 6.5V13",
  bag: "M3.5 5h9l-.8 9h-7.4zM6 5V3.6A2 2 0 0 1 10 3.6V5",
  ship: "M2.5 10.5 3.6 7h8.8l1.1 3.5M4.8 7V4.3h6.4V7M2 12.8c1.2 0 1.2 1 2.4 1s1.2-1 2.4-1 1.2 1 2.4 1 1.2-1 2.4-1 1.2 1 2.4 1",
  box: "M8 2 14 5v6l-6 3-6-3V5zM2 5l6 3 6-3M8 8v6",
  tag: "M2.5 8.2V2.5H8.2L14 8.3 8.3 14z",
  up: "M8 12V3M4.5 6.5 8 3l3.5 3.5M2.5 13.5h11",
  chevronLeft: "M10 3.5 5.5 8l4.5 4.5",
  users: "M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5zM1.8 13.5c.4-2.3 2.1-3.6 4.2-3.6s3.8 1.3 4.2 3.6M10.6 3.2a2.2 2.2 0 0 1 0 4.2M12 10.1c1.2.4 2 1.6 2.2 3.4",
};

export function Icon({ name, className = "ic", size }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
