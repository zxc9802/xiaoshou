import { createUsageReporter } from '../server/openlux-usage.ts';
await createUsageReporter({tool:'xiaoshou',getMainAppUrl:()=>process.env.MAIN_APP_URL?.trim() || 'https://www.qycm.top'}).flush();
