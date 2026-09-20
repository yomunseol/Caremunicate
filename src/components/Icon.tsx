import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// The icon primitive.
//
// One <svg> wrapper with explicit width and height, so a glyph this app draws
// itself can never render at an unknown size. Lucide covers most of the app;
// anything drawn locally is a path entry here.
// ---------------------------------------------------------------------------

const ICON_PATHS: Record<string, ReactNode> = {
  // A calendar with a pencil over its bottom-right corner.
  'calendar-edit': (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
      <path d="M18.4 13.6l2 2-4.4 4.4H14v-2z" />
    </>
  ),
  // Three SOLID dots — never rings, never specks.
  'ellipsis-vertical': (
    <>
      <circle cx="12" cy="5" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
};

type IconProps = {
  name: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
};

function Icon({ name, size = 20, strokeWidth = 2, className = '' }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
         className={className} aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  )
}

export default Icon;
