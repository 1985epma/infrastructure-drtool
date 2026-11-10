import { hasResources } from '../validate.js';
import { createCustomProvider } from './custom.js';
import { createEksProvider } from './eks.js';
import { createK8sProvider } from './k8s.js';
import { createSimulatedProvider } from './sim.js';
import { createNoopProvider, withResources } from './with-resources.js';

export function createProvider(env, deps) {
  let base;
  switch (env.provider) {
    case 'eks':
      base = createEksProvider(env, deps);
      break;
    case 'custom':
      base = createCustomProvider(env, deps);
      break;
    case 'k8s':
      base = createK8sProvider(env, deps);
      break;
    case 'aws':
      base = createNoopProvider();
      break;
    case 'simulated':
      return createSimulatedProvider(env, deps);
    default:
      throw new Error(`Provider desconhecido: ${env.provider}`);
  }
  return hasResources(env) ? withResources(base, env, deps) : base;
}
