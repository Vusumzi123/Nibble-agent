import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'flight' },
  {
    path: 'flight',
    loadComponent: () => import('./pages/flight').then((m) => m.FlightPage),
  },
  {
    path: 'metrics',
    loadComponent: () => import('./pages/metrics').then((m) => m.MetricsPage),
  },
  {
    path: 'queues',
    loadComponent: () => import('./pages/queues').then((m) => m.QueuesPage),
  },
  {
    path: 'missions',
    loadComponent: () => import('./pages/missions').then((m) => m.MissionsPage),
  },
  {
    path: 'logs',
    loadComponent: () => import('./pages/logs').then((m) => m.LogsPage),
  },
  {
    path: 'logs/:name',
    loadComponent: () => import('./pages/logs').then((m) => m.LogsPage),
  },
  {
    path: 'setup',
    loadComponent: () => import('./pages/setup').then((m) => m.SetupPage),
  },
  { path: '**', redirectTo: 'flight' },
];
