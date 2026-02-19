import type { Command } from './command.js';
import { setupCommand } from './setup.js';
import { setPickupPointCommand } from './set-pickup-point.js';

export const commands: Command[] = [setupCommand, setPickupPointCommand];

