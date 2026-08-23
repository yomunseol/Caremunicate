import type { RouteKey } from '../types';

interface NavigationProps {
  currentRoute: RouteKey;
  onNavigate: (route: RouteKey) => void;
}

export default function Navigation({ currentRoute, onNavigate }: NavigationProps) {
  const navItems: Array<{ label: string; route: RouteKey }> = [
    { label: 'Home', route: 'home' },
    { label: 'Pricing', route: 'pricing' },
    { label: 'Signup', route: 'signup' },
    { label: 'Login', route: 'login' },
    { label: 'Profile', route: 'profile' },
  ];

  const isActive = (route: RouteKey) => route === currentRoute;

  return (
    <header className="topbar">
      <button className="brand" type="button" onClick={() => onNavigate('home')}>
        <img src="/Caremunicate.png" alt="Caremunicate logo" className="brand-logo" />
        <span>Caremunicate</span>
      </button>

      <nav className="nav-links" aria-label="Primary">
        {navItems.map((item) => (
          <button
            key={item.route}
            className={`nav-link ${isActive(item.route) ? 'active' : ''}` }
            type="button"
            onClick={() => onNavigate(item.route)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="nav-actions">
        <button className="ghost-button" type="button" onClick={() => onNavigate('login')}>
          Log in
        </button>
        <button className="primary-button" type="button" onClick={() => onNavigate('signup')}>
          Sign up
        </button>
      </div>
    </header>
  );
}