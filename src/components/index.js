// Barrel re-exports for the design-system primitives. Per-component source
// lives under ./ui/. Import either way:
//   import { Modal, Badge } from '../../components';
//   import { Modal }        from '../../components/ui/Modal';

export { ToastContainer } from './ui/Toast';
export { Spinner }        from './ui/Spinner';
export { Badge, allocationBadge, timesheetBadge, certBadge } from './ui/Badge';
export { Modal }          from './ui/Modal';
export { Field }          from './ui/Field';
export { EmptyState }     from './ui/EmptyState';
export { TableWrap, Th, Td } from './ui/Table';
export { SignaturePad } from './ui/SignaturePad';
export { DateField } from './ui/DateField';
export { DateRangeFilter, presetBounds, RANGE_PRESETS } from './ui/DateRangeFilter';
export { ClockField } from './ui/ClockField';
export { DailyTimesheetForm, blankDaily, dailyFromHeader } from './timesheet/DailyTimesheetForm';
export { TimesheetDetailView, printTimesheet, printTimesheetBatch } from './timesheet/TimesheetDetailView';
