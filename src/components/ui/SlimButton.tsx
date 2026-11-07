import type { ButtonHTMLAttributes, ReactNode } from 'react';

// ---------------------------------------------------------------------------
// SlimButton — the one action-button style, matching the navbar pills.
//
// Reference proportions (from `.nav-actions`): 40px height, 1rem inline
// padding, 0.85rem bold type, fully rounded. The same class also drives the
// app-wide `.primary-button` / `.ghost-button` defaults so every action button
// shares this silhouette.
// ---------------------------------------------------------------------------

type SlimButtonVariant = 'primary' | 'secondary' | 'ghost';

type SlimButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: SlimButtonVariant;
};

export default function SlimButton({
  children,
  variant = 'secondary',
  className = '',
  type = 'button',
  ...rest
}: SlimButtonProps) {
  return (
    <button
      type={type}
      className={`slim-button slim-button--${variant}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  );
}
