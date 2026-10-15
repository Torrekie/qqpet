// The native host applies this policy before Ruffle in every frame.
window.__qqpetRespectSystemAudio = true;

// iOS 15 requires an Ambient session in the actual WebContent audio process
// before constructing an AudioContext. Native lazy initialization can start I/O
// without calling JavaScript resume(), so a timed resume delay cannot guard it.
if (window.__qqpetRequireNativeAudioPolicy === true) {
  window.__qqpetAudioPolicyState = 'required';
  const constructors = new Map();
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Native = window[name];
    if (typeof Native !== 'function') continue;
    let guarded = constructors.get(Native);
    if (!guarded) {
      guarded = new Proxy(Native, {
        construct(target, args, newTarget) {
          const fail = (state, message) => {
            window.__qqpetAudioPolicyState = state;
            window.__qqpetAudioPolicyError = message;
            throw new Error(`QQPet audio policy: ${message}`);
          };
          if (window.__qqpetLocalAudioOutput !== true)
            return fail('local-output-unavailable', 'WebContent audio output was not configured.');
          if (typeof window.__qqpetPrepareAudio !== 'function')
            return fail('native-bridge-unavailable', 'The native Ambient audio policy is unavailable.');
          let prepared;
          try {
            prepared = window.__qqpetPrepareAudio();
          } catch {
            return fail('native-call-failed', 'The native Ambient audio policy failed.');
          }
          if (prepared !== true)
            return fail('native-category-failed', 'The native audio session did not confirm Ambient.');
          window.__qqpetAudioPolicyState = 'ready';
          delete window.__qqpetAudioPolicyError;
          return Reflect.construct(target, args, newTarget);
        },
      });
      constructors.set(Native, guarded);
    }
    window[name] = guarded;
  }
  if (!constructors.size) window.__qqpetAudioPolicyState = 'audio-context-unavailable';
} else {
  window.__qqpetAudioPolicyState = 'system-default';
}
