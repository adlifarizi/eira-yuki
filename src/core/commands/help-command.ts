import { CoreResponse, IncomingMessage } from '../types';
import { CommandRouter } from './command-router';
import { BotCommand } from './types';

/**
 * Creates the `.help` command listing all registered prefix commands.
 */
export function createHelpCommand(router: CommandRouter): BotCommand {
  return {
    name: 'help',
    aliases: ['menu'],
    description: 'Tampilkan daftar perintah cepat yang tersedia',
    execute: async (_args: string[], incoming: IncomingMessage): Promise<CoreResponse> => {
      const prefix = router.getPrefix();
      const visibleCommands = router
        .getCommands()
        .filter((cmd) => !cmd.ownerOnly || incoming.role === 'owner');

      const lines = visibleCommands.map((cmd) => {
        const aliasText = cmd.aliases?.length
          ? ` (${cmd.aliases.map((a) => `${prefix}${a}`).join(', ')})`
          : '';
        return `▸ ${prefix}${cmd.name}${aliasText}\n  ${cmd.description}`;
      });

      return {
        text: `Daftar Perintah Cepat\n──────────────\n\n${lines.join('\n\n')}`,
      };
    },
  };
}
