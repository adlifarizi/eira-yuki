import { CoreTool } from './types';

export interface CurrentTimeToolOptions {
  timeZone: string;
  locale: string;
}

export function createCurrentTimeTool(options: CurrentTimeToolOptions): CoreTool {
  const defaultTz = options.timeZone;
  const defaultLocale = options.locale;

  return {
    name: 'get_current_time',
    description: 'Get current accurate real-time date, day, and time.',
    parameters: {
      type: 'object',
      properties: {
        timeZone: {
          type: 'string',
          description: `Timezone identifier, default "${defaultTz}".`,
        },
      },
    },
    ownerOnly: false,
    execute: async (params) => {
      const tz = params?.timeZone || defaultTz;
      const now = new Date();
      const timeStr = now.toLocaleTimeString(defaultLocale, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: tz,
      });
      const dateStr = now.toLocaleDateString(defaultLocale, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: tz,
      });
      return {
        time: timeStr,
        date: dateStr,
        timeZone: tz,
      };
    },
  };
}
