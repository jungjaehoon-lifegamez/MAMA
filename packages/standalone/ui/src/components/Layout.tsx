import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function Layout() {
  return (
    <div className="flex h-full bg-bg">
      <Sidebar />
      <main
        id="app-scroll-container"
        className="flex-1 min-w-0 overflow-y-auto pb-14 md:pb-0"
      >
        <Outlet />
      </main>
    </div>
  );
}
