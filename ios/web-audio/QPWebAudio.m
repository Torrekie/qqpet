#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <JavaScriptCore/JavaScriptCore.h>
#import <unistd.h>

// Pinned WebKit ObjC injected-bundle SPI. Do not export WKBundleInitialize:
// its presence skips the principal-class/delegate path in InjectedBundleMac.mm.
// https://github.com/WebKit/WebKit/blob/e9549695e591a4c0cdcca61a13cdfc6fc12ec776/Source/WebKit/WebProcess/InjectedBundle/mac/InjectedBundleMac.mm#L171-L210
// https://github.com/WebKit/WebKit/blob/e9549695e591a4c0cdcca61a13cdfc6fc12ec776/Source/WebKit/WebProcess/InjectedBundle/API/mac/WKWebProcessPlugIn.h#L35-L40
@class WKWebProcessPlugInController, WKWebProcessPlugInBrowserContextController;
@class WKWebProcessPlugInFrame, WKWebProcessPlugInScriptWorld;

@protocol WKWebProcessPlugIn <NSObject>
@optional
- (void)webProcessPlugIn:(WKWebProcessPlugInController *)controller initializeWithObject:(id)object;
- (void)webProcessPlugIn:(WKWebProcessPlugInController *)controller didCreateBrowserContextController:(WKWebProcessPlugInBrowserContextController *)browser;
@end

// https://github.com/WebKit/WebKit/blob/e9549695e591a4c0cdcca61a13cdfc6fc12ec776/Source/WebKit/WebProcess/InjectedBundle/API/Cocoa/WKWebProcessPlugInLoadDelegate.h#L49
@protocol WKWebProcessPlugInLoadDelegate <NSObject>
@optional
- (void)webProcessPlugInBrowserContextController:(WKWebProcessPlugInBrowserContextController *)controller willInjectUserScriptForFrame:(WKWebProcessPlugInFrame *)frame inScriptWorld:(WKWebProcessPlugInScriptWorld *)world;
@end

// https://github.com/WebKit/WebKit/blob/e9549695e591a4c0cdcca61a13cdfc6fc12ec776/Source/WebKit/WebProcess/InjectedBundle/API/mac/WKWebProcessPlugInBrowserContextController.h#L47
@interface WKWebProcessPlugInBrowserContextController : NSObject
@property(nonatomic, weak) id<WKWebProcessPlugInLoadDelegate> loadDelegate;
@end

// https://github.com/WebKit/WebKit/blob/e9549695e591a4c0cdcca61a13cdfc6fc12ec776/Source/WebKit/WebProcess/InjectedBundle/API/Cocoa/WKWebProcessPlugInFrame.h#L57
@interface WKWebProcessPlugInFrame : NSObject
- (JSContext *)jsContextForWorld:(WKWebProcessPlugInScriptWorld *)world;
@end

static BOOL QPPrepareAmbientAudio(void) {
    AVAudioSession *session=AVAudioSession.sharedInstance;
    NSError *error=nil;
    BOOL applied=[session setCategory:AVAudioSessionCategoryAmbient mode:AVAudioSessionModeDefault options:0 error:&error];
    // Read the actual native state for every constructor, including after a
    // document/process replacement. Setting a category never activates I/O.
    BOOL ready=applied&&[session.category isEqualToString:AVAudioSessionCategoryAmbient]&&[session.mode isEqualToString:AVAudioSessionModeDefault];
    NSLog(@"QQPet WebAudio pid=%d category=%@ mode=%@ ready=%@ error=%@",getpid(),session.category,session.mode,ready?@"yes":@"no",error.localizedDescription ?: @"none");
    return ready;
}

@interface QPWebAudioPlugin : NSObject <WKWebProcessPlugIn,WKWebProcessPlugInLoadDelegate>
@end

@implementation QPWebAudioPlugin
- (void)webProcessPlugIn:(WKWebProcessPlugInController *)controller initializeWithObject:(id)object {
    QPPrepareAmbientAudio();
}
- (void)webProcessPlugIn:(WKWebProcessPlugInController *)controller didCreateBrowserContextController:(WKWebProcessPlugInBrowserContextController *)browser {
    if ([browser respondsToSelector:@selector(setLoadDelegate:)]) browser.loadDelegate=self;
    else NSLog(@"QQPet WebAudio pid=%d category bridge unavailable: no load delegate",getpid());
}
- (void)webProcessPlugInBrowserContextController:(WKWebProcessPlugInBrowserContextController *)controller willInjectUserScriptForFrame:(WKWebProcessPlugInFrame *)frame inScriptWorld:(WKWebProcessPlugInScriptWorld *)world {
    if (![frame respondsToSelector:@selector(jsContextForWorld:)]) {
        NSLog(@"QQPet WebAudio pid=%d category bridge unavailable: no frame context",getpid());
        return;
    }
    JSContext *context=[frame jsContextForWorld:world];
    if (!context) {
        NSLog(@"QQPet WebAudio pid=%d category bridge unavailable: empty frame context",getpid());
        return;
    }
    // WebKit calls this before its document-start user script in every frame.
    // The block crosses into this WebContent process synchronously, so category
    // verification finishes before the JS wrapper calls the native constructor.
    context[@"__qqpetPrepareAudio"]=^BOOL { return QPPrepareAmbientAudio(); };
}
@end
