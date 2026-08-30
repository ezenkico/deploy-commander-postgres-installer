import { describe, expect, it } from 'vitest';
import type { AdminCredentials } from './credentials';
import { buildInstallPlan } from './installPlan';

describe('buildInstallPlan', () => {
  it('builds the persistent PostgreSQL runner plan without putting credentials in resource metadata', () => {
    const credentials: AdminCredentials = {
      username: 'pg_admin_example',
      password: 'secret-password',
    };

    const plan = buildInstallPlan(credentials);

    expect(plan).toEqual({
      services: {
        postgres: {
          image: 'postgres:15',
          aliases: ['postgres'],
          environment: {
            POSTGRES_USER: credentials.username,
            POSTGRES_PASSWORD: credentials.password,
            POSTGRES_DB: 'postgres',
          },
          resources: [
            {
              resource_type: 'postgres',
              name: 'postgres',
              metadata: { engine: 'postgres', version: '15' },
            },
          ],
          volumes: [{ name: 'postgres-data', mount_path: '/var/lib/postgresql/data' }],
        },
      },
      volumes: ['postgres-data'],
    });

    const resourceMetadata = plan.services?.postgres?.resources?.[0]?.metadata;
    expect(JSON.stringify(resourceMetadata)).not.toContain(credentials.username);
    expect(JSON.stringify(resourceMetadata)).not.toContain(credentials.password);
  });
});
