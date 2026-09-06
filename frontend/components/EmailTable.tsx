import StatusBadge from "./StatusBadge";

export interface EmailRow {
  id: string;
  recipient: string;
  subject: string;
  status: string;
  sender_email: string;
  dateLabel: string;
  dateValue: string | null;
}

export default function EmailTable({
  rows,
  loading,
  emptyMessage,
  dateColumnLabel,
}: {
  rows: EmailRow[];
  loading: boolean;
  emptyMessage: string;
  dateColumnLabel: string;
}) {
  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-1 text-center text-sm text-slate-500">
        <p className="font-medium text-slate-700">{emptyMessage}</p>
        <p>Nothing to show here yet.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3">Recipient</th>
            <th className="px-4 py-3">Subject</th>
            <th className="px-4 py-3">Sender</th>
            <th className="px-4 py-3">{dateColumnLabel}</th>
            <th className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 font-medium text-slate-900">{row.recipient}</td>
              <td className="max-w-xs truncate px-4 py-3 text-slate-600">{row.subject}</td>
              <td className="px-4 py-3 text-slate-600">{row.sender_email}</td>
              <td className="px-4 py-3 text-slate-600">
                {row.dateValue ? new Date(row.dateValue).toLocaleString() : "—"}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={row.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
