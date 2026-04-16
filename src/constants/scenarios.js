export const SCENARIOS = [
  { value: 'standard',           label: 'Standard Shift' },
  { value: 'late_start_admin',   label: 'Late Start — Admin/Booking Delay (pay 8h, charge actual)' },
  { value: 'late_start_worker',  label: 'Late Start — Worker Fault (pay & charge actual)' },
  { value: 'rain_off_partial',   label: 'Rain-Off Partial (pay 8h, charge 4h)' },
  { value: 'rain_off_cancelled', label: 'Rain-Off Cancelled (pay 8h, no charge)' },
  { value: 'no_work_available',  label: 'No Available Work (pay 8h, no charge)' },
  { value: 'training_day',       label: 'Training Day (pay 8h, no charge)' },
  { value: 'annual_leave',       label: 'Annual Leave (8h)' },
  { value: 'personal_leave',     label: 'Personal Leave (8h) — requires reason' },
  { value: 'lwop',               label: 'Leave Without Pay (LWOP)' },
  { value: 'public_holiday',     label: 'Public Holiday (full-time: 8h auto)' },
  { value: 'emergency_callout',  label: 'Emergency Callout (casual)' },
];

export const WORKER_TYPES = [
  { value: 'full-time',     label: 'Full-Time Employee' },
  { value: 'casual',        label: 'Casual Employee' },
  { value: 'subcontractor', label: 'Subcontractor' },
];
