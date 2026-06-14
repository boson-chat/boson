// Curated shortcode → emoji map. Dependency-free and intentionally small — the
// common set people actually type in chat. `:shortcode:` in a message resolves
// here (unknown codes render literally), and the composer picker lists these.
// Extend freely; aliases just point at the same char.
export const EMOJI: Readonly<Record<string, string>> = {
  // smileys
  smile: '😄', smiley: '😃', grin: '😁', laughing: '😆', joy: '😂', rofl: '🤣',
  sweat_smile: '😅', wink: '😉', blush: '😊', slight_smile: '🙂', upside_down: '🙃',
  thinking: '🤔', neutral_face: '😐', expressionless: '😑', no_mouth: '😶',
  smirk: '😏', unamused: '😒', roll_eyes: '🙄', grimacing: '😬', sleepy: '😪',
  sleeping: '😴', relieved: '😌', yum: '😋', stuck_out_tongue: '😛',
  stuck_out_tongue_winking_eye: '😜', sunglasses: '😎', nerd: '🤓', cowboy: '🤠',
  hugs: '🤗', shush: '🤫', money_mouth: '🤑', star_struck: '🤩', partying: '🥳',
  cry: '😢', sob: '😭', frowning: '😦', anguished: '😧', fearful: '😨',
  cold_sweat: '😰', scream: '😱', confounded: '😖', disappointed: '😞', worried: '😟',
  triumph: '😤', rage: '😡', angry: '😠', cursing: '🤬', exploding_head: '🤯',
  flushed: '😳', hot: '🥵', cold: '🥶', dizzy_face: '😵', mask: '😷',
  sick: '🤢', vomiting: '🤮', sneezing: '🤧', pleading: '🥺',
  // gestures / people
  wave: '👋', raised_hand: '✋', ok_hand: '👌', pinch: '🤏', v: '✌️',
  crossed_fingers: '🤞', love_you: '🤟', metal: '🤘', call_me: '🤙', point_up: '☝️',
  point_down: '👇', point_left: '👈', point_right: '👉', '+1': '👍', thumbsup: '👍',
  '-1': '👎', thumbsdown: '👎', fist: '✊', punch: '👊', clap: '👏', raised_hands: '🙌',
  open_hands: '👐', pray: '🙏', handshake: '🤝', muscle: '💪', writing_hand: '✍️',
  selfie: '🤳', nail_care: '💅', eyes: '👀', brain: '🧠', shrug: '🤷',
  facepalm: '🤦', tipping_hand: '💁', no_good: '🙅', ok_person: '🙆', raising_hand: '🙋',
  bow: '🙇', man: '👨', woman: '👩', baby: '👶', ghost: '👻', alien: '👽', robot: '🤖',
  // hearts / symbols
  heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚',
  blue_heart: '💙', purple_heart: '💜', black_heart: '🖤', white_heart: '🤍',
  broken_heart: '💔', two_hearts: '💕', sparkling_heart: '💖', heartbeat: '💓',
  fire: '🔥', sparkles: '✨', star: '⭐', star2: '🌟', dizzy: '💫', boom: '💥',
  zap: '⚡', sweat_drops: '💦', dash: '💨', tada: '🎉', confetti: '🎊', balloon: '🎈',
  gift: '🎁', '100': '💯', anger: '💢', question: '❓', exclamation: '❗',
  warning: '⚠️', no_entry: '⛔', check: '✅', white_check_mark: '✅', x: '❌',
  heavy_check_mark: '✔️', cross_mark: '❌', recycle: '♻️', sos: '🆘',
  // objects / misc
  rocket: '🚀', computer: '💻', keyboard: '⌨️', desktop: '🖥️', floppy: '💾',
  bulb: '💡', wrench: '🔧', hammer: '🔨', gear: '⚙️', lock: '🔒', unlock: '🔓',
  key: '🔑', mag: '🔍', bell: '🔔', mute: '🔇', email: '📧', envelope: '✉️',
  link: '🔗', paperclip: '📎', pushpin: '📌', calendar: '📅', clipboard: '📋',
  bug: '🐛', skull: '💀', poop: '💩', clown: '🤡', wave_goodbye: '👋',
  coffee: '☕', beer: '🍺', pizza: '🍕', hamburger: '🍔', cake: '🍰', cookie: '🍪',
  eyes_emoji: '👀', thumbsup_all: '👍', clock: '🕐', hourglass: '⏳', alarm: '⏰',
  sun: '☀️', moon: '🌙', cloud: '☁️', rainbow: '🌈', snowflake: '❄️', umbrella: '☔',
  dog: '🐶', cat: '🐱', penguin: '🐧', unicorn: '🦄', snake: '🐍', whale: '🐳',
};

// Resolve a shortcode to its emoji char, or null when unknown.
export function emojiFor(shortcode: string): string | null {
  return EMOJI[shortcode.toLowerCase()] ?? null;
}

// De-duped (shortcode, char) list for the composer picker, first-seen order.
export const EMOJI_LIST: ReadonlyArray<{ code: string; char: string }> = (() => {
  const seen = new Set<string>();
  const out: { code: string; char: string }[] = [];
  for (const [code, char] of Object.entries(EMOJI)) {
    if (seen.has(char)) continue;
    seen.add(char);
    out.push({ code, char });
  }
  return out;
})();
