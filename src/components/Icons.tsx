import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;
const base = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const SparkIcon = (props: IconProps) => <svg {...base} {...props}><path d="m12 3 1.25 4.1a5 5 0 0 0 3.4 3.4L21 12l-4.35 1.5a5 5 0 0 0-3.4 3.4L12 21l-1.25-4.1a5 5 0 0 0-3.4-3.4L3 12l4.35-1.5a5 5 0 0 0 3.4-3.4L12 3Z" /></svg>;
export const UploadIcon = (props: IconProps) => <svg {...base} {...props}><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>;
export const ImageIcon = (props: IconProps) => <svg {...base} {...props}><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9" r="1.5"/><path d="m5 17 4.5-4 3.5 3 2.5-2 3.5 3"/></svg>;
export const TrashIcon = (props: IconProps) => <svg {...base} {...props}><path d="M4 7h16m-10 4v5m4-5v5M9 7l1-3h4l1 3m3 0-1 13H7L6 7"/></svg>;
export const CheckIcon = (props: IconProps) => <svg {...base} {...props}><path d="m5 12 4 4L19 6"/></svg>;
export const ChevronIcon = (props: IconProps) => <svg {...base} {...props}><path d="m8 10 4 4 4-4"/></svg>;
export const CopyIcon = (props: IconProps) => <svg {...base} {...props}><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>;
export const ShieldIcon = (props: IconProps) => <svg {...base} {...props}><path d="M12 3 5 6v5c0 4.5 2.8 8.3 7 10 4.2-1.7 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>;
export const MenuIcon = (props: IconProps) => <svg {...base} {...props}><path d="M4 7h16M4 12h16M4 17h16"/></svg>;
export const PlusIcon = (props: IconProps) => <svg {...base} {...props}><path d="M12 5v14M5 12h14"/></svg>;
export const ArrowIcon = (props: IconProps) => <svg {...base} {...props}><path d="M5 12h14m-5-5 5 5-5 5"/></svg>;
