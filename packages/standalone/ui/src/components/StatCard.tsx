export default function StatCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'warning'
        ? 'text-warning-text'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-text';
  return (
    <div className="bg-surface rounded-xl px-4 py-3 shadow-[var(--shadow-xs)] border border-border">
      <div className="text-[11px] text-text-tertiary">{label}</div>
      <div className={`text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}
