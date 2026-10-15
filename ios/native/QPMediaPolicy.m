#import "QPMediaPolicy.h"

// Safari 15.1 WebKit's declarations, including the BOOL setter/getter ABI:
// https://github.com/WebKit/WebKit/blob/e9549695e591a4c0cdcca61a13cdfc6fc12ec776/Source/WebKit/UIProcess/API/Cocoa/WKPreferencesPrivate.h#L144-L148
// https://github.com/WebKit/WebKit/blob/e9549695e591a4c0cdcca61a13cdfc6fc12ec776/Source/WebKit/UIProcess/API/Cocoa/_WKExperimentalFeature.h#L31-L37
@interface _WKExperimentalFeature : NSObject
@property(nonatomic, readonly, copy) NSString *key;
@end

@interface WKPreferences (QPMediaPolicy)
+ (NSArray<_WKExperimentalFeature *> *)_experimentalFeatures;
- (void)_setEnabled:(BOOL)value forExperimentalFeature:(_WKExperimentalFeature *)feature;
- (BOOL)_isEnabledForExperimentalFeature:(_WKExperimentalFeature *)feature;
@end

NSString *QPConfigureMediaPreferences(WKPreferences *preferences) {
    if (NSProcessInfo.processInfo.operatingSystemVersion.majorVersion != 15) return @"system-default";
    if (![WKPreferences respondsToSelector:@selector(_experimentalFeatures)] ||
        ![preferences respondsToSelector:@selector(_setEnabled:forExperimentalFeature:)] ||
        ![preferences respondsToSelector:@selector(_isEnabledForExperimentalFeature:)]) {
        NSLog(@"QQPet media policy: experimental preference API unavailable; retaining GPU media fallback.");
        return @"gpu-fallback";
    }
    NSArray<_WKExperimentalFeature *> *features=[WKPreferences _experimentalFeatures];
    if ([features isKindOfClass:NSArray.class]) {
        for (_WKExperimentalFeature *feature in features) {
            if (![feature respondsToSelector:@selector(key)] || ![feature.key isEqualToString:@"UseGPUProcessForMediaEnabled"]) continue;
            // This setting changes media alone; WebGL/canvas preferences remain
            // unchanged. Local WebAudio avoids RemoteAudioSession losing its
            // cached Ambient category when a GPU process is recreated:
            // https://github.com/WebKit/WebKit/blob/e9549695e591a4c0cdcca61a13cdfc6fc12ec776/Source/WebKit/WebProcess/GPU/media/WebMediaStrategy.cpp#L49-L56
            [preferences _setEnabled:NO forExperimentalFeature:feature];
            if (![preferences _isEnabledForExperimentalFeature:feature]) return @"webcontent";
            NSLog(@"QQPet media policy: GPU media preference remained enabled; retaining GPU media fallback.");
            return @"gpu-fallback";
        }
    }
    NSLog(@"QQPet media policy: GPU media feature unavailable; retaining GPU media fallback.");
    return @"gpu-fallback";
}
