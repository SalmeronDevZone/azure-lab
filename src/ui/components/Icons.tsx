// Iconos: servicios de Azure (versiones simplificadas con los colores oficiales) e iconos de interfaz.
import type { CSSProperties, ReactNode } from 'react';

const G = ({ id, a, b }: { id: string; a: string; b: string }) => (
  <defs>
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={a} />
      <stop offset="1" stopColor={b} />
    </linearGradient>
  </defs>
);

const SERVICE: Record<string, (id: string) => ReactNode> = {
  vm: (id) => (
    <>
      <G id={id} a="#5ea0ef" b="#0078d4" />
      <rect x="1" y="3" width="16" height="10.5" rx="0.8" fill={`url(#${id})`} />
      <path d="M6 15.5h6M9 13.5v2" stroke="#7a7a7a" strokeWidth="1.4" />
      <path d="M6.2 6.2 9 4.6l2.8 1.6v3.2L9 11 6.2 9.4z" fill="#9cebff" />
    </>
  ),
  vmss: (id) => (
    <>
      <G id={id} a="#5ea0ef" b="#0078d4" />
      <rect x="3" y="1.5" width="13" height="8.5" rx="0.6" fill="#83b9f9" />
      <rect x="1" y="5" width="13" height="8.5" rx="0.6" fill={`url(#${id})`} />
      <path d="M4.5 16h6M7.5 13.5V16" stroke="#7a7a7a" strokeWidth="1.3" />
    </>
  ),
  disk: () => (
    <>
      <ellipse cx="9" cy="4.5" rx="7" ry="2.6" fill="#83b9f9" />
      <path d="M2 4.5v9c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-9c0 1.4-3.1 2.6-7 2.6s-7-1.2-7-2.6z" fill="#0078d4" />
    </>
  ),
  storage: (id) => (
    <>
      <G id={id} a="#37c2b1" b="#258277" />
      <rect x="1" y="3" width="16" height="12" rx="0.8" fill={`url(#${id})`} />
      <rect x="2.6" y="6" width="12.8" height="2.6" fill="#fff" opacity=".9" />
      <rect x="2.6" y="9.6" width="12.8" height="2.6" fill="#fff" opacity=".6" />
    </>
  ),
  webapp: (id) => (
    <>
      <G id={id} a="#3ccbf4" b="#2892df" />
      <circle cx="9" cy="9" r="7.6" fill={`url(#${id})`} />
      <path d="M1.8 9h14.4M9 1.4c2.4 2.2 2.4 13 0 15.2M9 1.4c-2.4 2.2-2.4 13 0 15.2" stroke="#fff" strokeWidth=".9" fill="none" opacity=".9" />
    </>
  ),
  plan: (id) => (
    <>
      <G id={id} a="#3ccbf4" b="#2892df" />
      <rect x="2" y="2" width="14" height="14" rx="1" fill={`url(#${id})`} />
      <path d="M5 6h8M5 9h8M5 12h5" stroke="#fff" strokeWidth="1.3" />
    </>
  ),
  sqlserver: () => (
    <>
      <path d="M2 4.2v9.6C2 15.6 5.1 17 9 17s7-1.4 7-3.2V4.2z" fill="#0078d4" />
      <ellipse cx="9" cy="4.2" rx="7" ry="2.7" fill="#9cebff" />
      <text x="9" y="13" fontSize="5.4" textAnchor="middle" fill="#fff" fontWeight="700" fontFamily="Segoe UI, sans-serif">
        SQL
      </text>
    </>
  ),
  sqldb: () => (
    <>
      <path d="M3 4.2v9.6C3 15.5 5.7 17 9 17s6-1.5 6-3.2V4.2z" fill="#005ba1" />
      <ellipse cx="9" cy="4.2" rx="6" ry="2.5" fill="#50e6ff" />
      <text x="9" y="13" fontSize="5" textAnchor="middle" fill="#fff" fontWeight="700" fontFamily="Segoe UI, sans-serif">
        SQL
      </text>
    </>
  ),
  vnet: () => (
    <>
      <path d="M1 9 4.2 5.2v7.6zM17 9l-3.2-3.8v7.6z" fill="#50c878" />
      <circle cx="6.6" cy="9" r="1.5" fill="#0078d4" />
      <circle cx="9" cy="9" r="1.5" fill="#0078d4" />
      <circle cx="11.4" cy="9" r="1.5" fill="#0078d4" />
    </>
  ),
  nsg: () => (
    <>
      <path d="M9 1 2.5 3.6v5c0 4 2.8 7 6.5 8.4 3.7-1.4 6.5-4.4 6.5-8.4v-5z" fill="#0078d4" />
      <path d="M9 3 4.4 4.9v3.8c0 2.9 2 5.1 4.6 6.2z" fill="#50e6ff" opacity=".9" />
    </>
  ),
  pip: () => (
    <>
      <rect x="1.5" y="4" width="15" height="10" rx="1.2" fill="#0078d4" />
      <text x="9" y="11.4" fontSize="5.4" textAnchor="middle" fill="#fff" fontWeight="700" fontFamily="Segoe UI, sans-serif">
        IP
      </text>
    </>
  ),
  nic: () => (
    <>
      <rect x="2" y="5" width="14" height="9" rx="1" fill="#50c878" />
      <path d="M4.5 3v2M7 3v2M9.5 3v2M12 3v2" stroke="#2e7d32" strokeWidth="1.3" />
      <rect x="5" y="8" width="8" height="3" fill="#fff" opacity=".85" />
    </>
  ),
  lb: () => (
    <>
      <circle cx="9" cy="4" r="2.6" fill="#0078d4" />
      <path d="M9 6.6v3M9 9.6 4 13M9 9.6l5 3.4M9 9.6V13" stroke="#50c878" strokeWidth="1.4" />
      <circle cx="4" cy="14.5" r="1.8" fill="#50e6ff" />
      <circle cx="9" cy="14.5" r="1.8" fill="#50e6ff" />
      <circle cx="14" cy="14.5" r="1.8" fill="#50e6ff" />
    </>
  ),
  keyvault: () => (
    <>
      <circle cx="9" cy="9" r="7.6" fill="#ffb900" />
      <circle cx="9" cy="7.6" r="2.4" fill="#fff" />
      <path d="M8 9.5h2v4.5H8z" fill="#fff" />
    </>
  ),
  acr: () => (
    <>
      <rect x="1.5" y="6" width="15" height="10" rx="1" fill="#0078d4" />
      <rect x="3.2" y="2" width="4.2" height="4.2" fill="#50e6ff" />
      <rect x="7.6" y="2" width="4.2" height="4.2" fill="#9cebff" />
      <path d="M4 9.5h10M4 12.5h10" stroke="#fff" strokeWidth="1.1" opacity=".8" />
    </>
  ),
  aci: () => (
    <>
      <path d="M9 1.5 16 5.2v7.6L9 16.5 2 12.8V5.2z" fill="#0078d4" />
      <path d="M9 1.5 16 5.2 9 9 2 5.2z" fill="#50e6ff" />
    </>
  ),
  aks: () => (
    <>
      <path d="M5 2 8 3.6v3.3L5 8.5 2 6.9V3.6zM13 2l3 1.6v3.3l-3 1.6-3-1.6V3.6zM9 9.4l3 1.6v3.3l-3 1.6-3-1.6V11z" fill="#326ce5" />
      <path d="M5 2 8 3.6 5 5.2 2 3.6zM13 2l3 1.6-3 1.6-3-1.6zM9 9.4l3 1.6-3 1.6-3-1.6z" fill="#7aa2f2" />
    </>
  ),
  identity: () => (
    <>
      <circle cx="9" cy="6" r="3.4" fill="#ffb900" />
      <path d="M2.8 16c0-3.4 2.8-5.8 6.2-5.8s6.2 2.4 6.2 5.8z" fill="#ffb900" />
      <circle cx="13.6" cy="13.4" r="3" fill="#0078d4" />
      <path d="m12.3 13.4 1 1 1.7-1.9" stroke="#fff" strokeWidth="1" fill="none" />
    </>
  ),
  loganalytics: () => (
    <>
      <rect x="2" y="2" width="14" height="14" rx="1.2" fill="#0078d4" />
      <path d="M4.5 12.5 7.5 8.5l2.4 2 3.6-5" stroke="#50e6ff" strokeWidth="1.6" fill="none" />
    </>
  ),
  appinsights: () => (
    <>
      <circle cx="9" cy="7.4" r="5.8" fill="#8661c5" />
      <path d="M6.6 13.6h4.8v1.6H6.6zM7.2 16h3.6v1H7.2z" fill="#8661c5" />
      <path d="M9 4.4a3 3 0 0 0-3 3" stroke="#fff" strokeWidth="1.2" fill="none" />
    </>
  ),
  actiongroup: () => (
    <>
      <path d="M3 13V8.4a6 6 0 0 1 12 0V13l1.4 1.8H1.6z" fill="#0078d4" />
      <circle cx="9" cy="16" r="1.6" fill="#50e6ff" />
    </>
  ),
  alert: () => (
    <>
      <path d="M9 1.5 17 16H1z" fill="#ffb900" />
      <path d="M9 6.5v4.6" stroke="#323130" strokeWidth="1.6" />
      <circle cx="9" cy="13.4" r=".95" fill="#323130" />
    </>
  ),
  autoscale: () => (
    <>
      <rect x="1.5" y="8" width="5" height="8" fill="#50e6ff" />
      <rect x="7" y="5" width="4.5" height="11" fill="#0078d4" />
      <rect x="12" y="2" width="4.5" height="14" fill="#005ba1" />
    </>
  ),
  rg: () => (
    <>
      <path d="M2 3h5l1.4 1.8H16v10.4H2z" fill="#0078d4" />
      <rect x="4" y="7" width="10" height="1.4" fill="#fff" opacity=".85" />
      <rect x="4" y="10" width="7" height="1.4" fill="#fff" opacity=".6" />
    </>
  ),
  subscription: () => (
    <>
      <path d="M9 1.2 15.5 4.9v8.2L9 16.8 2.5 13.1V4.9z" fill="#ffb900" />
      <text x="9" y="11.6" fontSize="7" textAnchor="middle" fill="#fff" fontWeight="700" fontFamily="Segoe UI, sans-serif">
        $
      </text>
    </>
  ),
  entra: () => (
    <>
      <path d="M9 1 1.5 10.4 9 17l7.5-6.6z" fill="#0078d4" />
      <path d="M9 1 4.2 10.4 9 13.6l4.8-3.2z" fill="#50e6ff" />
    </>
  ),
  monitor: () => (
    <>
      <circle cx="9" cy="9" r="7.6" fill="#0078d4" />
      <path d="M3.2 9.6h2.6l1.4-3.4 2.4 6 1.6-3.6h3.6" stroke="#fff" strokeWidth="1.3" fill="none" />
    </>
  ),
  cost: () => (
    <>
      <circle cx="9" cy="9" r="7.6" fill="#57a300" />
      <text x="9" y="12.4" fontSize="9" textAnchor="middle" fill="#fff" fontWeight="700" fontFamily="Segoe UI, sans-serif">
        €
      </text>
    </>
  ),
  advisor: () => (
    <>
      <circle cx="9" cy="9" r="7.6" fill="#0078d4" />
      <path d="m6.4 9.2 1.8 1.8 3.6-4" stroke="#fff" strokeWidth="1.6" fill="none" />
    </>
  ),
  policy: () => (
    <>
      <rect x="3" y="1.5" width="12" height="15" rx="1" fill="#0078d4" />
      <path d="M5.5 5.5h7M5.5 8.5h7M5.5 11.5h4" stroke="#fff" strokeWidth="1.2" />
      <circle cx="13.6" cy="13.6" r="3" fill="#57a300" />
    </>
  ),
  devops: () => (
    <>
      <path d="M16.5 4.2v9.4l-3.8 3.1-5.9-2.1v2.1L3.4 12.3l9.6.8V4.8zM13.3 4.7 7.9 1.3v2.2L2.9 5 1.5 6.8v4.1l2.1.9V6.6z" fill="#0078d4" />
    </>
  ),
  shell: () => (
    <>
      <rect x="1" y="2.5" width="16" height="13" rx="1" fill="#323130" />
      <path d="m4 6.5 2.6 2.4L4 11.3M8 11.6h5" stroke="#fff" strokeWidth="1.3" fill="none" />
    </>
  ),
  academy: () => (
    <>
      <path d="M9 2 1 6l8 4 8-4z" fill="#8661c5" />
      <path d="M4 7.8v4.1c0 1.2 2.3 2.6 5 2.6s5-1.4 5-2.6V7.8L9 10.3z" fill="#b392f0" />
      <path d="M16 6v5" stroke="#8661c5" strokeWidth="1.2" />
    </>
  ),
  deployments: () => (
    <>
      <rect x="2" y="2" width="14" height="14" rx="1" fill="#0078d4" />
      <path d="M9 4.5v6.5M6 8l3 3 3-3M5 13.5h8" stroke="#fff" strokeWidth="1.3" fill="none" />
    </>
  ),
  all: () => (
    <>
      <rect x="2" y="2" width="6" height="6" fill="#0078d4" />
      <rect x="10" y="2" width="6" height="6" fill="#50e6ff" />
      <rect x="2" y="10" width="6" height="6" fill="#50e6ff" />
      <rect x="10" y="10" width="6" height="6" fill="#0078d4" />
    </>
  ),
  function: () => (
    <>
      <path d="M9 1.5 16.5 9 9 16.5 1.5 9z" fill="#ffb900" />
      <path d="M10 4 6.6 9.6h2.6L8 14l3.6-6H9z" fill="#fff" />
    </>
  ),
  dns: () => (
    <>
      <circle cx="9" cy="9" r="7.6" fill="#0078d4" />
      <path d="M1.6 9h14.8M9 1.4c2.2 2 2.2 13.2 0 15.2M9 1.4c-2.2 2-2.2 13.2 0 15.2" stroke="#9cebff" strokeWidth=".9" fill="none" />
      <rect x="8.6" y="10.4" width="8.4" height="6" rx=".8" fill="#50e6ff" />
      <text x="12.8" y="15.2" fontSize="4.2" textAnchor="middle" fill="#004578" fontWeight="700" fontFamily="Segoe UI, sans-serif">
        DNS
      </text>
    </>
  ),
  servicebus: () => (
    <>
      <rect x="1.5" y="4" width="15" height="10" rx="1.2" fill="#0078d4" />
      <rect x="3.5" y="6.5" width="3" height="5" rx=".5" fill="#9cebff" />
      <rect x="7.5" y="6.5" width="3" height="5" rx=".5" fill="#50e6ff" />
      <rect x="11.5" y="6.5" width="3" height="5" rx=".5" fill="#9cebff" />
    </>
  ),
  graph: () => (
    <>
      <circle cx="4" cy="5" r="2.4" fill="#0078d4" />
      <circle cx="14" cy="4.5" r="2.4" fill="#50e6ff" />
      <circle cx="9" cy="13.5" r="2.8" fill="#005ba1" />
      <path d="M4 5l10-.5M4 5l5 8.5M14 4.5l-5 9" stroke="#0078d4" strokeWidth="1" />
    </>
  ),
  mail: () => (
    <>
      <rect x="1.5" y="3.5" width="15" height="11" rx="1" fill="#0078d4" />
      <path d="m2 4.5 7 5.4 7-5.4" stroke="#fff" strokeWidth="1.2" fill="none" />
    </>
  ),
};

let gid = 0;

export function ServiceIcon({ name, size = 18, style }: { name: string; size?: number; style?: CSSProperties }) {
  const f = SERVICE[name] ?? SERVICE.all;
  const id = `g${++gid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" style={{ flex: '0 0 auto', ...style }} aria-hidden>
      {f(id)}
    </svg>
  );
}

const UI: Record<string, ReactNode> = {
  search: <path d="M10.5 3a5.5 5.5 0 0 1 4.3 8.9l3 3a.7.7 0 0 1-1 1l-3-3A5.5 5.5 0 1 1 10.5 3zm0 1.4a4.1 4.1 0 1 0 0 8.2 4.1 4.1 0 0 0 0-8.2z" transform="translate(-3 -1)" />,
  shell: <path d="M2 3h16v14H2zm1.4 1.4v11.2h13.2V4.4zM5 7l3 3-3 3-.9-.9L6.2 10 4.1 7.9zm4.5 5h5v1.3h-5z" />,
  bell: <path d="M10 2a5 5 0 0 1 5 5v3.6l1.6 2.6c.2.4 0 .8-.5.8H3.9c-.5 0-.7-.4-.5-.8L5 10.6V7a5 5 0 0 1 5-5zm2 13.4a2 2 0 0 1-4 0z" />,
  gear: <path d="M8.5 1.5h3l.5 2.3 1.4.6 2-1.3 2.1 2.1-1.3 2 .6 1.4 2.3.5v3l-2.3.5-.6 1.4 1.3 2-2.1 2.1-2-1.3-1.4.6-.5 2.3h-3l-.5-2.3-1.4-.6-2 1.3-2.1-2.1 1.3-2-.6-1.4-2.3-.5v-3l2.3-.5.6-1.4-1.3-2 2.1-2.1 2 1.3 1.4-.6zM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />,
  help: <path d="M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm0 11.4a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm0-8.4c-1.8 0-3 1.2-3 2.7h1.4c0-.8.6-1.4 1.6-1.4s1.5.6 1.5 1.3c0 1.4-2.2 1.4-2.2 3.6h1.4c0-1.5 2.2-1.7 2.2-3.6C13 6.1 11.8 5 10 5z" />,
  close: <path d="m4.6 3.6 5.4 5.4 5.4-5.4 1 1L11 10l5.4 5.4-1 1L10 11l-5.4 5.4-1-1L9 10 3.6 4.6z" />,
  add: <path d="M9.3 3h1.4v6.3H17v1.4h-6.3V17H9.3v-6.3H3V9.3h6.3z" />,
  refresh: <path d="M10 3a7 7 0 0 1 6.3 4V4h1.4v5.5h-5.5V8.1h3.1A5.6 5.6 0 1 0 15.6 11H17A7 7 0 1 1 10 3z" />,
  delete: <path d="M8 2h4a1 1 0 0 1 1 1v1h4v1.4h-1.2l-.9 11.2A1.6 1.6 0 0 1 13.3 18H6.7a1.6 1.6 0 0 1-1.6-1.4L4.2 5.4H3V4h4V3a1 1 0 0 1 1-1zm-2.4 3.4.9 11c0 .1.1.2.2.2h6.6c.1 0 .2-.1.2-.2l.9-11zM8 7h1.3v8H8zm2.7 0H12v8h-1.3z" />,
  play: <path d="M5 3.3v13.4c0 .5.6.8 1 .5l10.4-6.7a.6.6 0 0 0 0-1L6 2.8c-.4-.3-1 0-1 .5z" />,
  stop: <rect x="4" y="4" width="12" height="12" rx="1" />,
  restart: <path d="M10 3a7 7 0 1 1-7 7h1.4A5.6 5.6 0 1 0 6 6l2 2H3V3l2 2a7 7 0 0 1 5-2z" />,
  edit: <path d="m13.6 2.6 3.8 3.8L7.2 16.6 2.6 17.4l.8-4.6zm0 2-8.9 8.9-.4 2.2 2.2-.4L15.4 6.4z" />,
  copy: <path d="M7 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-2v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2V3a1 1 0 0 1 1-1zm.4 3H13a1 1 0 0 1 1 1v6.6h1.6V3.4H7.4zm-3 1.4v9.2h8.2V6.4z" />,
  download: <path d="M9.3 2h1.4v9.3l3.3-3.3 1 1-5 5-5-5 1-1 3.3 3.3zM3 15.6h14V17H3z" />,
  upload: <path d="m10 2 5 5-1 1-3.3-3.3V14H9.3V4.7L6 8 5 7zM3 15.6h14V17H3z" />,
  chevron: <path d="m7.4 4 6 6-6 6-1-1 5-5-5-5z" />,
  chevronDown: <path d="m4 7.4 6 6 6-6-1-1-5 5-5-5z" />,
  back: <path d="m12.6 4-6 6 6 6 1-1-5-5 5-5z" />,
  menu: <path d="M2 4.3h16v1.4H2zm0 5h16v1.4H2zm0 5h16v1.4H2z" />,
  check: <path d="m7.5 13.6 8.6-8.6 1 1-9.6 9.6L2.9 11l1-1z" />,
  info: <path d="M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-.7 6.5v6h1.4v-6zM10 5.4a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z" />,
  warn: <path d="M10 2.4 18.4 17H1.6zm-.7 5.3v5h1.4v-5zm.7 6.1a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8z" />,
  error: <path d="M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM7.3 6.3l-1 1L9 10l-2.7 2.7 1 1L10 11l2.7 2.7 1-1L11 10l2.7-2.7-1-1L10 9z" />,
  success: <path d="M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm3.4 5.1-4.6 4.6-2.2-2.2-1 1 3.2 3.2 5.6-5.6z" />,
  maximize: <path d="M3 3h14v14H3zm1.4 1.4v11.2h11.2V4.4z" />,
  minimize: <path d="M3 9.3h14v1.4H3z" />,
  open: <path d="M4 3h5v1.4H4.4v11.2h11.2V11H17v6H3V3zm7 0h6v6h-1.4V5.4l-6 6-1-1 6-6H11z" />,
  code: <path d="m6.8 5 1 1-4 4 4 4-1 1-5-5zm6.4 0 5 5-5 5-1-1 4-4-4-4zM11 3l1.3.4-3.3 13.2-1.3-.3z" />,
  braces: <path d="M6 3h1.4v1.4H6.4c-.4 0-.6.2-.6.6v3.4c0 .8-.4 1.3-1 1.6.6.3 1 .8 1 1.6V15c0 .4.2.6.6.6h1v1.4H6c-1.1 0-1.6-.6-1.6-1.6v-3.6c0-.5-.3-.8-.9-.8H3V9h.5c.6 0 .9-.3.9-.8V4.6C4.4 3.6 4.9 3 6 3zm8 0c1.1 0 1.6.6 1.6 1.6v3.6c0 .5.3.8.9.8h.5v1.4h-.5c-.6 0-.9.3-.9.8v3.6c0 1-.5 1.6-1.6 1.6h-1.4v-1.4h1c.4 0 .6-.2.6-.6v-3.4c0-.8.4-1.3 1-1.6-.6-.3-1-.8-1-1.6V5c0-.4-.2-.6-.6-.6h-1V3z" />,
  tag: <path d="M3 3h6.6l8 8-6.6 6.6-8-8zm1.4 1.4v4.6l6.6 6.6 4.6-4.6L9 4.4zM6.6 5.6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" />,
  lock: <path d="M10 2a4 4 0 0 1 4 4v2h1.5c.6 0 1 .4 1 1v8c0 .6-.4 1-1 1h-11c-.6 0-1-.4-1-1V9c0-.6.4-1 1-1H6V6a4 4 0 0 1 4-4zm0 1.4A2.6 2.6 0 0 0 7.4 6v2h5.2V6A2.6 2.6 0 0 0 10 3.4z" />,
  people: <path d="M7 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm7 1.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM7 10.5c3.2 0 5.5 1.8 5.5 4.5v1.5h-11V15c0-2.7 2.3-4.5 5.5-4.5zm7 .3c2.3 0 4 1.4 4 3.6v1.6h-4.1V15c0-1.6-.6-3-1.7-3.9.5-.2 1.1-.3 1.8-.3z" />,
  activity: <path d="M2 10h3.2L7.6 4l4.2 12 2.2-6H18v1.4h-3l-3.2 8.6L7.6 8 6.2 11.4H2z" />,
  overview: <path d="M3 3h6v6H3zm8 0h6v6h-6zM3 11h6v6H3zm8 0h6v6h-6z" />,
  json: <path d="M6 3h1.4v1.4H6.4c-.4 0-.6.2-.6.6v3.4c0 .8-.4 1.3-1 1.6.6.3 1 .8 1 1.6V15c0 .4.2.6.6.6h1v1.4H6c-1.1 0-1.6-.6-1.6-1.6v-3.6c0-.5-.3-.8-.9-.8H3V9h.5c.6 0 .9-.3.9-.8V4.6C4.4 3.6 4.9 3 6 3zm8 0c1.1 0 1.6.6 1.6 1.6v3.6c0 .5.3.8.9.8h.5v1.4h-.5c-.6 0-.9.3-.9.8v3.6c0 1-.5 1.6-1.6 1.6h-1.4v-1.4h1c.4 0 .6-.2.6-.6v-3.4c0-.8.4-1.3 1-1.6-.6-.3-1-.8-1-1.6V5c0-.4-.2-.6-.6-.6h-1V3z" />,
  network: <path d="M10 2a2 2 0 0 1 .7 3.9V9h5.3v3.1a2 2 0 1 1-1.4 0v-1.7H5.4v1.7a2 2 0 1 1-1.4 0V9h5.3V5.9A2 2 0 0 1 10 2z" />,
  key: <path d="M13 2a5 5 0 1 1-1.8 9.7L9.9 13H8v2H6v2H2v-3.6l6.3-6.3A5 5 0 0 1 13 2zm1 2.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z" />,
  chart: <path d="M3 3h1.4v12.6H17V17H3zm12.6 2 1 1-4.8 4.8-2.6-2.6-3.4 3.4-1-1 4.4-4.4 2.6 2.6z" />,
  link: <path d="M8 6h-2.5a4 4 0 0 0 0 8H8v-1.4H5.5a2.6 2.6 0 0 1 0-5.2H8zm4 0v1.4h2.5a2.6 2.6 0 0 1 0 5.2H12V14h2.5a4 4 0 0 0 0-8zM6.5 9.3h7v1.4h-7z" />,
  terminal: <path d="M2 3h16v14H2zm1.4 1.4v11.2h13.2V4.4zM5 7l3 3-3 3-.9-.9L6.2 10 4.1 7.9zm4.5 5h5v1.3h-5z" />,
  cloud: <path d="M10.5 4a5 5 0 0 1 4.9 4A4 4 0 0 1 15 16H5a4 4 0 0 1-.5-8A5 5 0 0 1 10.5 4z" />,
  star: <path d="m10 2 2.4 5 5.6.6-4.2 3.8 1.2 5.5L10 14l-5 2.9 1.2-5.5L2 7.6 7.6 7z" />,
  filter: <path d="M2 3h16l-6 7.2V17l-4-2v-4.8z" />,
  rocket: <path d="M16.8 2.6c.4.1.6.3.6.7.3 3.6-1.3 6.9-4.4 9.4l.2 2.9-3 2.4-1-3.4-2.9-2.9-3.4-1 2.4-3 2.9.2c2.5-3.1 5.8-4.7 9.4-4.4zM12.6 6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM4.6 13.4l2 2c-.8 1.2-2.4 1.8-4.2 2 .2-1.8.8-3.4 2.2-4z" />,
  git: <path d="M18.6 9.2 10.8 1.4a1.4 1.4 0 0 0-2 0L7.2 3l2 2a1.7 1.7 0 0 1 2.1 2.1l2 2a1.7 1.7 0 1 1-1 1L10.4 8.2v5a1.7 1.7 0 1 1-1.4 0V8.1a1.7 1.7 0 0 1-.9-2.2L6.1 3.9 1.4 8.6a1.4 1.4 0 0 0 0 2l7.8 7.8a1.4 1.4 0 0 0 2 0l7.4-7.2a1.4 1.4 0 0 0 0-2z" />,
  pipeline: <path d="M3 3h5v5H3zm9 0h5v5h-5zM3 12h5v5H3zm2-4h1.4v4H5zm3-2.7h4v1.4H8zm6.5 2.7h1.4v4.6c0 .8-.6 1.4-1.4 1.4H8v-1.4h6.5z" />,
  boards: <path d="M2 3h4.6v14H2zm5.7 0h4.6v9H7.7zm5.7 0H18v11h-4.6z" />,
  branch: <path d="M5 2a2 2 0 0 1 .7 3.9v4A4 4 0 0 1 8 9h2.2a2.6 2.6 0 0 0 2.6-2.4 2 2 0 1 1 1.4 0A4 4 0 0 1 10.2 10.4H8a2.6 2.6 0 0 0-2.3 2v1.7a2 2 0 1 1-1.4 0V5.9A2 2 0 0 1 5 2z" />,
  pr: <path d="M5 2a2 2 0 0 1 .7 3.9v8.2a2 2 0 1 1-1.4 0V5.9A2 2 0 0 1 5 2zm7.6.3 1 1-1.3 1.3H13a2.6 2.6 0 0 1 2.6 2.6v6.9a2 2 0 1 1-1.4 0V7.2c0-.7-.5-1.2-1.2-1.2h-.7l1.3 1.3-1 1-3-3z" />,
  env: <path d="M3 4h14v9H3zm1.4 1.4v6.2h11.2V5.4zM7 15h6v1.4H7z" />,
  library: <path d="M3 3h3v14H3zm4.5 0h3v14h-3zm4.6.6 2.9-.8 3.6 13.5-2.9.8z" />,
  settings2: <path d="M8.5 1.5h3l.5 2.3 1.4.6 2-1.3 2.1 2.1-1.3 2 .6 1.4 2.3.5v3l-2.3.5-.6 1.4 1.3 2-2.1 2.1-2-1.3-1.4.6-.5 2.3h-3l-.5-2.3-1.4-.6-2 1.3-2.1-2.1 1.3-2-.6-1.4-2.3-.5v-3l2.3-.5.6-1.4-1.3-2 2.1-2.1 2 1.3 1.4-.6zM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />,
  file: <path d="M5 2h6.6L16 6.4V17a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm.4 1.4v13.2h9.2V7.4H11V3.4z" />,
  folder: <path d="M2 4h6l1.6 2H18v11H2zm1.4 1.4v10.2h13.2V7.4H9l-1.6-2z" />,
  book: <path d="M4 2.5h11a1 1 0 0 1 1 1V17H5.5A1.5 1.5 0 0 1 4 15.5zm1.4 1.4v10.7c.1 0 .1 0 .1 0h9.1V3.9z" />,
  trophy: <path d="M5 2h10v2h3v2.5A3.5 3.5 0 0 1 14.6 10 5 5 0 0 1 10.7 13v2.6H14V17H6v-1.4h3.3V13A5 5 0 0 1 5.4 10 3.5 3.5 0 0 1 2 6.5V4h3zm10 3.4v3.1c.9-.3 1.6-1.1 1.6-2V5.4zm-11.6 0v1.1c0 .9.7 1.7 1.6 2V5.4z" />,
};

export function Icon({ name, size = 16, className, style, title }: { name: string; size?: number; className?: string; style?: CSSProperties; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" className={className ? `icon ${className}` : 'icon'} style={{ flex: '0 0 auto', ...style }} aria-hidden={!title}>
      {title ? <title>{title}</title> : null}
      {UI[name] ?? UI.info}
    </svg>
  );
}
