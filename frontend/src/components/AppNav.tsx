import { NavLink } from "react-router-dom";

const linkClass = ({ isActive }: { isActive: boolean }) =>
  "appNavLink" + (isActive ? " appNavLinkActive" : "");

export function AppNav() {
  return (
    <header className="appNavBar">
      <div className="container appNavInner">
        <span className="appNavBrand">Up/Down</span>
        <nav className="appNav" aria-label="Main">
          <NavLink to="/" end className={linkClass}>
            Live
          </NavLink>
          <NavLink to="/strategy" className={linkClass}>
            Strategy sim
          </NavLink>
        </nav>
      </div>
    </header>
  );
}
