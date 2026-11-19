export interface Delivered {
  from: string;
  at: string;
}

/** What the consumer reports on /health: a connection to the broker, and one message published and consumed. */
export class ConsumerState {
  private connected = false;
  private delivered: Delivered | null = null;

  markConnected(): void {
    this.connected = true;
  }

  markDisconnected(): void {
    this.connected = false;
  }

  markDelivered(message: Delivered): void {
    this.delivered = message;
  }

  get healthy(): boolean {
    return this.connected && this.delivered !== null;
  }

  get body(): { connected: boolean; delivered: boolean; last: Delivered | null } {
    return { connected: this.connected, delivered: this.delivered !== null, last: this.delivered };
  }
}
