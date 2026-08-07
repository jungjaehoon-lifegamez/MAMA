/** Label/value pair shared by the task and trigger drawers. */
export default function DrawerDetail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-text">{children}</dd>
    </div>
  );
}
