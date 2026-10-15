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

// Cocoa/iOS SPI, configured before a dedicated process pool is created:
// https://github.com/WebKit/WebKit/blob/Safari-612.2.9/Source/WebKit/UIProcess/API/Cocoa/_WKProcessPoolConfiguration.h
@interface _WKProcessPoolConfiguration : NSObject
@property(nonatomic, copy) NSURL *injectedBundleURL;
@end
@interface WKProcessPool (QPMediaPolicy)
- (instancetype)_initWithConfiguration:(_WKProcessPoolConfiguration *)configuration;
@end

NSString *QPConfigureMediaConfiguration(WKWebViewConfiguration *configuration) {
    if (NSProcessInfo.processInfo.operatingSystemVersion.majorVersion != 15) return @"system-default";
    WKPreferences *preferences=configuration.preferences;
    if (![WKPreferences respondsToSelector:@selector(_experimentalFeatures)] ||
        ![preferences respondsToSelector:@selector(_setEnabled:forExperimentalFeature:)] ||
        ![preferences respondsToSelector:@selector(_isEnabledForExperimentalFeature:)]) {
        NSLog(@"QQPet media policy: experimental preference API unavailable; WebAudio will be unavailable.");
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
            if ([preferences _isEnabledForExperimentalFeature:feature]) {
                NSLog(@"QQPet media policy: GPU media preference remained enabled; WebAudio will be unavailable.");
                return @"gpu-fallback";
            }
            Class poolConfiguration=NSClassFromString(@"_WKProcessPoolConfiguration");
            NSURL *bundle=[NSBundle.mainBundle URLForResource:@"QQPetWebAudio" withExtension:@"bundle"];
            if (!poolConfiguration || ![poolConfiguration instancesRespondToSelector:@selector(setInjectedBundleURL:)] ||
                ![WKProcessPool instancesRespondToSelector:@selector(_initWithConfiguration:)] || !bundle) {
                NSLog(@"QQPet media policy: WebContent audio bundle configuration unavailable; WebAudio will be unavailable.");
                return @"audio-policy-unavailable";
            }
            _WKProcessPoolConfiguration *settings=[[poolConfiguration alloc] init];
            settings.injectedBundleURL=bundle;
            WKProcessPool *pool=[[WKProcessPool alloc] _initWithConfiguration:settings];
            if (!pool) return @"audio-policy-unavailable";
            configuration.processPool=pool;
            return @"webcontent";
        }
    }
    NSLog(@"QQPet media policy: GPU media feature unavailable; WebAudio will be unavailable.");
    return @"gpu-fallback";
}
