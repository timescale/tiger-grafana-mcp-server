import { grafanaDashboardLink } from './grafanaDashboardLink.js';
import { userInstanceBasicInformation } from './userInstanceBasicInformation.js';

export const apiFactories = [
  userInstanceBasicInformation,
  grafanaDashboardLink,
] as const;
