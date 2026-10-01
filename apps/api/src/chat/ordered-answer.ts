/** Keep asynchronously verified fragments at their original model positions. */
export class OrderedAnswer {
  private fragments: Array<{ position: number; text: string }> = [];
  append(position: number, text: string): void { this.fragments.push({ position, text }); }
  render(): string {
    return this.fragments.slice().sort((a, b) => a.position - b.position).map(item => item.text).join('');
  }
}
