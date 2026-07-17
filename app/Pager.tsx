"use client";

export const PER_PAGE = 10;

export default function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.min(10, Math.max(1, Math.ceil(total / PER_PAGE)));
  if (pages <= 1) return null;
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
      <button className="secondary" style={{ margin: 0, padding: "4px 10px" }}
              disabled={page === 0} onClick={() => onPage(page - 1)}>‹</button>
      {Array.from({ length: pages }, (_, i) => (
        <button key={i} className="secondary"
                style={{ margin: 0, padding: "4px 10px",
                         borderColor: i === page ? "var(--accent)" : undefined,
                         color: i === page ? "var(--accent)" : undefined }}
                onClick={() => onPage(i)}>
          {i + 1}
        </button>
      ))}
      <button className="secondary" style={{ margin: 0, padding: "4px 10px" }}
              disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>›</button>
    </div>
  );
}
