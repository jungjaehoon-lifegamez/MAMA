/* eslint-env browser */

import { OperatorCockpitModule } from './modules/operator-cockpit.js';

const operatorCockpit = new OperatorCockpitModule();
operatorCockpit.init();

declare global {
  interface Window {
    operatorCockpitModule?: OperatorCockpitModule;
  }
}

window.operatorCockpitModule = operatorCockpit;
