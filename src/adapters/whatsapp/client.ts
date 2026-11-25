import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  WASocket,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import path from 'path';
import fs from 'node:fs';
import { Logger } from 'pino';
import { Config } from '../../config';
import { MessageHandler } from './message';

export class WhatsAppClient {
  private sock: WASocket | null = null;

  constructor(
    private logger: Logger,
    private config: Config,
    private messageHandler: MessageHandler
  ) {}

  async start() {
    const authDir = path.join(process.cwd(), 'storage', 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    let { state, saveCreds } = await useMultiFileAuthState(authDir);
    
    // If not registered but partial session exists from interrupted pairing, clear and start fresh
    if (!state.creds.registered && state.creds.me) {
      this.logger.warn('Detected partial unregistered session in storage/auth. Resetting auth state for fresh pairing...');
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true });
      const fresh = await useMultiFileAuthState(authDir);
      state = fresh.state;
      saveCreds = fresh.saveCreds;
    }

    const { version } = await fetchLatestBaileysVersion();
    
    this.logger.info(`Starting bot with Baileys version ${version}`);

    const baileysLogger = this.logger.child({ module: 'baileys' });
    baileysLogger.level = 'warn';

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: !this.config.adapters.whatsapp.usePairingCode,
      logger: baileysLogger as any,
    });

    if (this.config.adapters.whatsapp.usePairingCode && !state.creds.registered) {
      const phoneNumber = this.config.adapters.whatsapp.phoneNumber?.replace(/[^0-9]/g, '');
      if (!phoneNumber) {
        this.logger.error('Phone number is required for pairing code');
      } else {
        setTimeout(async () => {
          try {
            if (this.sock) {
              const code = await this.sock.requestPairingCode(phoneNumber);
              this.logger.info(`Pairing code generated: ${code}`);
              console.log(`\n=================================\nYour Pairing Code: ${code}\n=================================\n`);
            }
          } catch (error) {
            this.logger.error(error, 'Failed to request pairing code');
          }
        }, 3000);
      }
    }

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        
        if (isLoggedOut && !state.creds.registered) {
          this.logger.warn('Pairing attempt failed or expired. Resetting auth credentials for clean retry...');
          fs.rmSync(authDir, { recursive: true, force: true });
          fs.mkdirSync(authDir, { recursive: true });
          setTimeout(() => this.start(), 3000);
          return;
        }

        const shouldReconnect = !isLoggedOut;
        this.logger.warn(`Connection closed (status ${statusCode}). Reconnecting: ${shouldReconnect}`);
        
        if (shouldReconnect) {
          setTimeout(() => this.start(), 3000);
        }
      } else if (connection === 'open') {
        this.logger.info('Bot connected to WhatsApp!');
      }
    });

    this.sock.ev.on('messages.upsert', async (m) => {
      for (const msg of m.messages) {
        // Ignore status broadcasts and broadcast channels
        if (msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid?.endsWith('@broadcast')) {
          continue;
        }

        // Allow incoming notify messages, and allow self-chat if user tests from the bot's own number
        const botJid = this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id) : '';
        const botLid = (this.sock?.user as any)?.lid ? jidNormalizedUser((this.sock?.user as any).lid) : '';
        const remoteNormalized = msg.key.remoteJid ? jidNormalizedUser(msg.key.remoteJid) : '';
        const isSelfChat = (botJid && remoteNormalized === botJid) || (botLid && remoteNormalized === botLid);

        if (msg.key.fromMe && !isSelfChat) {
          continue;
        }

        await this.messageHandler.handle(this.sock!, msg);
      }
    });
  }

  async sendMessage(chatId: string, text: string): Promise<boolean> {
    if (!this.sock) {
      this.logger.warn(`Cannot send message: WhatsApp socket not connected.`);
      return false;
    }
    try {
      await this.sock.sendMessage(chatId, { text, linkPreview: null });
      return true;
    } catch (err) {
      this.logger.error(err, `Failed to send WhatsApp message to ${chatId}`);
      return false;
    }
  }

  getSocket(): WASocket | null {
    return this.sock;
  }
}
