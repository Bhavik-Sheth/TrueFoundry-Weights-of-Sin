import { randomBytes } from 'node:crypto';
import type { Run } from '../types';

export interface RunRoute {
  connector: string;
  token: string;
  run: Run;
  sessionId?: string;
}

export class RunRoutes {
  private routes = new Map<string, RunRoute>();

  create(run: Run): RunRoute {
    const connector = 'contexo-run-' + randomBytes(12).toString('hex');
    const route = { connector, token: randomBytes(32).toString('hex'), run };
    this.routes.set(connector, route);
    return route;
  }

  restore(route: RunRoute) {
    if (this.routes.has(route.connector)) throw new Error('The run connector is already attached.');
    this.routes.set(route.connector, route);
  }

  get(connector: string) {
    return this.routes.get(connector);
  }

  revoke(connector: string) {
    this.routes.delete(connector);
  }
}
