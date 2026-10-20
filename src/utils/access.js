// Who may see money (pay rates, client rates, rate sets, payroll, invoices,
// Xero, plant charges, margins). One rule for every screen, matching the
// database's public.is_portal_admin():
//   admin access level AND not ticked as an allocator.
// Owner rule 2026-10-20: allocators never see pay, whatever their level.
export function canSeeMoney(worker) {
  return !!worker && worker.access_level === 'admin' && !worker.is_allocator;
}
