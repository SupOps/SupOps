import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { PageErrorBoundary } from './PageErrorBoundary';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Bell, BookOpen, Boxes, Brain, ChevronDown, Download, ChevronLeft, ChevronRight, ChevronsUpDown, Gauge, Globe, Headset, HeartPulse, LayoutDashboard, LogOut, Play, Plus, Server, Settings as SettingsIcon, ShieldCheck, Sparkles, Terminal, TerminalSquare, Users as UsersIcon, Workflow as WorkflowIcon,
} from 'lucide-react';
import { useInstall } from '../lib/pwa';
import { ObservabilityIcon } from './icons/ObservabilityIcon';
import { Lockup } from './Logo';
import { NewProjectDialog } from './NewProjectDialog';
import { api } from '../lib/api';
import { SIDEBAR_BREAKPOINT, useApp } from '../lib/store';
import type { PendingApproval, Project } from '../lib/types';
import { useLivePoll, useLiveUpdates } from '../lib/live';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
  /** Key into the live badge counts, for items that should show a pending total. */
  badge?: 'approvals' | 'alerts' | 'health' | 'incidents';
  /** Only shown to owner/admin accounts. */
  adminOnly?: boolean;
}

const GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/investigate', label: 'Investigate', icon: Terminal },
      { to: '/console', label: 'Console', icon: TerminalSquare },
      { to: '/call', label: 'Call', icon: Headset },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/observability', label: 'Observability', icon: ObservabilityIcon, badge: 'incidents' },
      { to: '/services', label: 'Services', icon: Boxes },
      { to: '/slos', label: 'SLOs', icon: Gauge },
      { to: '/synthetics', label: 'Synthetics', icon: Globe },
      { to: '/health', label: 'Health', icon: HeartPulse, badge: 'health' },
      { to: '/alerts', label: 'Alerts', icon: Bell, badge: 'alerts' },
      { to: '/runs', label: 'Runs', icon: Play },
      { to: '/approvals', label: 'Approvals', icon: ShieldCheck, badge: 'approvals' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { to: '/targets', label: 'Targets', icon: Server },
      { to: '/agents', label: 'Agents', icon: Sparkles },
      { to: '/knowledge', label: 'Knowledge', icon: BookOpen },
      { to: '/workflows', label: 'Workflows', icon: WorkflowIcon },
      { to: '/learning', label: 'Learning', icon: Brain },
      { to: '/users', label: 'Users', icon: UsersIcon, adminOnly: true },
      { to: '/settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
];

export function Layout() {
  const { user, signOut, projectId, setProjectId, sidebarCollapsed, setSidebarCollapsed, toggleSidebar } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // One push channel for the whole app: pages refetch when their data changes.
  useLiveUpdates(useQueryClient());

  /**
   * Force the rail shut below the breakpoint. `remember: false` so being collapsed by
   * a narrow viewport never overwrites the preference set on a wide one.
   */
  useEffect(() => {
    const apply = () => {
      if (window.innerWidth < SIDEBAR_BREAKPOINT) setSidebarCollapsed(true, false);
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [setSidebarCollapsed]);

  const collapsed = sidebarCollapsed;
  const install = useInstall();
  const isAdmin = user?.globalRole === 'owner' || user?.globalRole === 'admin';

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => api<Project[]>('/projects'),
  });

  const approvals = useQuery({
    queryKey: ['approvals', projectId],
    queryFn: () => api<PendingApproval[]>(`/runs/approvals/pending?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(5000),
  });

  const active = projects.data?.find((p) => p.id === projectId) ?? projects.data?.[0];
  if (active && active.id !== projectId) setProjectId(active.id);

  const alertCount = useQuery({
    queryKey: ['alertCount', projectId],
    queryFn: () => api<{ new: number }>(`/alerts/count?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(5000),
  });

  const healthCount = useQuery({
    queryKey: ['healthCount', projectId],
    queryFn: () => api<{ open: number }>(`/health/count?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(5000),
  });

  const incidentCount = useQuery({
    queryKey: ['incidentCount', projectId],
    queryFn: () => api<{ open: number }>(`/observability/count?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(10_000),
  });

  const badges = {
    incidents: incidentCount.data?.open ?? 0,
    approvals: approvals.data?.length ?? 0,
    alerts: alertCount.data?.new ?? 0,
    health: healthCount.data?.open ?? 0,
  };

  return (
    <div className="flex h-full">
      <aside className={clsx(
          'group/rail relative flex shrink-0 flex-col border-r border-hairline bg-tile transition-[width] duration-200',
          collapsed ? 'w-[68px]' : 'w-60',
        )}>
        {/* The whole header belongs to the logo. The collapse control used to sit
            beside it, which crowded the mark and read as an afterthought; it now
            straddles the rail's right edge, where the affordance is obvious and it
            costs the brand no room. */}
        <div className={clsx('flex py-4', collapsed ? 'justify-center px-3' : 'px-5')}>
          <Lockup
            size={collapsed ? 34 : 56}
            fill={!collapsed}
            showWordmark={!collapsed}
          />
        </div>

        <button
          onClick={toggleSidebar}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="absolute -right-3 top-7 z-30 grid h-6 w-6 place-items-center rounded-full border border-edge bg-tile-2 text-muted opacity-0 shadow-lg transition-all hover:bg-white/10 hover:text-ink focus-visible:opacity-100 group-hover/rail:opacity-100"
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </button>

        <div className={clsx('relative pb-3', collapsed ? 'px-2' : 'px-3')}>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            title={collapsed ? (active?.name ?? 'No project') : undefined}
            className={clsx(
              'flex min-h-[40px] items-center rounded-inner border border-edge bg-tile-2 text-left text-sm transition-colors hover:bg-white/5',
              collapsed ? 'w-full justify-center px-0' : 'w-full justify-between px-3 py-2',
            )}
          >
            {collapsed ? (
              // The project's initial is enough to tell two projects apart at a glance.
              <span className="text-xs font-semibold uppercase text-muted">
                {(active?.name ?? '?').slice(0, 2)}
              </span>
            ) : (
              <>
                <span className="min-w-0 truncate">{active?.name ?? 'No project'}</span>
                <ChevronsUpDown size={14} className="shrink-0 text-muted" />
              </>
            )}
          </button>
          {pickerOpen && (
            <div className="absolute left-2 right-2 z-30 mt-1 min-w-[180px] overflow-hidden rounded-inner border border-edge bg-tile-2 shadow-2xl">
              {projects.data?.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setProjectId(p.id);
                    setPickerOpen(false);
                  }}
                  className={clsx(
                    'block min-h-[40px] w-full px-3 py-2 text-left text-sm transition-colors hover:bg-white/5',
                    p.id === active?.id && 'text-blue-text',
                  )}
                >
                  {p.name}
                </button>
              ))}

              <button
                onClick={() => {
                  setPickerOpen(false);
                  setNewProjectOpen(true);
                }}
                className="flex min-h-[40px] w-full items-center gap-2 border-t border-hairline px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-white/5 hover:text-ink"
              >
                <Plus size={14} />
                New project
              </button>
            </div>
          )}
        </div>

        <nav className={clsx('flex-1 overflow-y-auto pb-3', collapsed ? 'px-2' : 'px-3')}>
          {GROUPS.map((group) => (
            <NavGroup key={group.label} label={group.label} collapsed={collapsed}>
              {group.items.filter((item) => !item.adminOnly || isAdmin).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end ?? false}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    clsx(
                      'relative flex min-h-[40px] items-center rounded-inner text-sm transition-colors',
                      collapsed ? 'justify-center px-0' : 'gap-2.5 px-3 py-2',
                      // A flat fill rather than a glow: the coloured block is already
                      // the strongest thing in the rail, and the drop shadow made it
                      // bloom into the tiles beside it.
                      isActive ? 'bg-blue text-white' : 'text-muted hover:bg-white/5 hover:text-ink',
                    )
                  }
                >
                  <item.icon size={collapsed ? 18 : 16} className="shrink-0" />
                  {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                  {item.badge && badges[item.badge] > 0 && (
                    <span
                      className={clsx(
                        'tabular rounded-full bg-amber font-semibold text-black',
                        collapsed
                          ? 'absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center px-1 text-[10px]'
                          : 'px-1.5 text-[11px]',
                      )}
                    >
                      {badges[item.badge]}
                    </span>
                  )}
                </NavLink>
              ))}
            </NavGroup>
          ))}
        </nav>

        <div className={clsx('border-t border-hairline', collapsed ? 'p-2' : 'p-3')}>
          {(install.canPrompt || install.manualIOS) && (
            <button
              type="button"
              onClick={() => void install.install()}
              disabled={install.manualIOS}
              title={install.manualIOS ? 'In Safari: Share, then Add to Home Screen' : 'Install SupOps as an app'}
              aria-label="Install app"
              className={clsx(
                'mb-2 flex w-full items-center rounded-inner border border-blue/40 bg-blue/10 text-[13px] font-medium text-blue-text transition-colors hover:bg-blue/20 disabled:cursor-default',
                collapsed ? 'justify-center py-2' : 'gap-2 px-3 py-2',
              )}
            >
              <Download size={15} />
              {!collapsed && (install.manualIOS ? 'Share → Add to Home Screen' : 'Install app')}
            </button>
          )}
          <div
            className={clsx(
              'flex items-center rounded-inner bg-tile-2',
              collapsed ? 'justify-center py-2' : 'gap-2.5 px-3 py-2',
            )}
          >
            <div className="grid h-7 w-7 place-items-center rounded-full bg-violet/20 text-xs font-semibold text-violet">
              {user?.name?.[0]?.toUpperCase() ?? '?'}
            </div>
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{user?.name ?? 'Signed out'}</div>
                <div className="truncate text-[11px] capitalize text-muted">{user?.globalRole}</div>
              </div>
            )}
            {!collapsed && <button
              onClick={() => {
                signOut();
                navigate('/login');
              }}
              className="grid h-9 w-9 place-items-center rounded-lg text-muted transition-colors hover:bg-white/5 hover:text-red"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={15} />
            </button>}
          </div>
          <div
            className={clsx(
              'mt-2 flex items-center rounded-inner border border-hairline',
              collapsed ? 'justify-center py-2' : 'gap-2 px-3 py-2',
            )}
            title={collapsed ? (active?.killSwitch ? 'Kill switch active' : 'System normal') : undefined}
          >
            <span
              className={clsx(
                'h-1.5 w-1.5 rounded-full',
                active?.killSwitch ? 'bg-red animate-pulse' : 'bg-green',
              )}
            />
            {!collapsed && (
              <span className="text-[11px] text-muted">
                {active?.killSwitch ? 'Kill switch active' : 'System normal'}
              </span>
            )}
          </div>
        </div>
      </aside>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <PageErrorBoundary key={location.pathname}>
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </PageErrorBoundary>
      </main>

      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(project) => {
          // Switch straight to it -- creating a project is always a prelude to
          // setting it up, and leaving the user on the old one costs a click.
          setProjectId(project.id);
          setNewProjectOpen(false);
          navigate('/targets');
        }}
      />
    </div>
  );
}

function NavGroup({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-1">
      {collapsed ? (
        // No heading when there is no room for one; a hairline keeps the grouping
        // legible without a label floating over icon-only items.
        <div className="mx-auto my-2 h-px w-7 bg-hairline" />
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted/70 transition-colors hover:text-muted"
        >
          <ChevronDown size={12} className={clsx('transition-transform', !open && '-rotate-90')} />
          {label}
        </button>
      )}
      {(open || collapsed) && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 px-6 pb-2 pt-7">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}

/**
 * Shown while a page's code downloads. Invisible for the first moments, so a fast
 * load never flashes a spinner; only a slow link sees it.
 */
function PageLoading() {
  return (
    <div className="page-loading grid min-h-[40vh] place-items-center" role="status" aria-label="Loading page">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-edge border-t-blue" />
    </div>
  );
}
