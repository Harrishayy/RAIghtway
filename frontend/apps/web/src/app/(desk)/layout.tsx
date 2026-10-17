import { TopNav } from '@/layout/TopNav';
export default function DeskLayout({ children }: { children: React.ReactNode }) {
  return <div className="app"><TopNav /><main className="app-main" id="main">{children}</main></div>;
}
