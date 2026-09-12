plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.remotedisplay.player"
    compileSdk = 34

    /*
     * Compress the native libraries in the APK; Android unpacks the one matching ABI at INSTALL
     * time. AGP's default since minSdk 23 is `useLegacyPackaging = false`, which stores the .so
     * entries uncompressed so they can be mmap'd straight out of the APK — the right default when
     * Play delivers a per-ABI split and the APK therefore carries exactly ONE .so.
     *
     * We are the other case. ScreenTinker sideloads a universal APK over its own OTA, so every
     * device carries all four ABIs and executes exactly one. #340's WebRTC publisher made that
     * costly: libjingle_peerconnection_so.so is ~43MB of the APK across arm64-v8a, armeabi-v7a,
     * x86 and x86_64, stored at 0% compression.
     *
     * Measured on the 2.0.9 build:
     *                     download      installed
     *   stored (default)  52,724,535    ~52.7MB
     *   compressed        29,557,559    ~41MB   (29.5MB APK + ~11.5MB extracted arm64)
     *
     * Smaller on BOTH axes, which only looks paradoxical until you notice that just one ABI is
     * ever extracted: the three nobody runs go from stored to deflated (~45%) and stay packed.
     * Download size is what actually matters here — the OTA path has no Range/resume, so a shorter
     * transfer is a transfer more likely to finish on a weak link.
     *
     * ⚠️ Do NOT reach for `splits { abi }` to solve the same problem. It renames the output to
     * app-<abi>-release.apk, and `resignReleaseV1` below is pinned to a single hardcoded path
     * behind `onlyIf { apk.exists() }` — it would silently stop running and ship v2-only APKs,
     * which #81 documents MDM signage uninstalls on reboot. Compression changes no filename, so
     * that task is untouched (verified: jarsigner reports "jar verified." on this build).
     */
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    defaultConfig {
        applicationId = "com.remotedisplay.player"
        minSdk = 23
        targetSdk = 34
        // Env-overridable so device-owner reinstalls (which require an ever-increasing
        // versionCode — downgrades are blocked) don't churn this file each build.
        versionCode = (System.getenv("VERSION_CODE") ?: findProperty("VERSION_CODE") as String? ?: "154").toInt()
        versionName = System.getenv("VERSION_NAME") ?: findProperty("VERSION_NAME") as String? ?: "2.0.9"
    }

    signingConfigs {
        create("release") {
            storeFile = file("../release-key.jks")
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: findProperty("KEYSTORE_PASSWORD") as String? ?: ""
            keyAlias = System.getenv("KEY_ALIAS") ?: findProperty("KEY_ALIAS") as String? ?: "remotedisplay"
            keyPassword = System.getenv("KEY_PASSWORD") ?: findProperty("KEY_PASSWORD") as String? ?: ""
            // #81: AGP ignores enableV1Signing at minSdk>=24, so assembleRelease emits a
            // v2-only APK. The v1 (JAR) signature that some MDM-managed signage (MAXHUB)
            // requires is added by the `resignReleaseV1` task below (apksigner re-sign).
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // ScheduleEval uses java.time (Instant/LocalDate/ZoneId), which is API 26 — but minSdk is
        // 24. Without desugaring, per-item dayparting/expiry threw NoClassDefFoundError on Android
        // 7.0/7.1, which are still common on cheap signage sticks and older TV boxes. Because that
        // is an Error and not an Exception, the evaluator's deliberate fail-open guard did not
        // catch it: the playlist update aborted before content downloaded, and the cold-start path
        // then cleared the playlist cache — so the screen sat on "waiting for content" and a reboot
        // did not help.
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        // Let JVM unit tests exercise Android-dependent code paths (e.g. ContentCache's real
        // download logic, which logs via android.util.Log) without Robolectric — stubbed Android
        // APIs return defaults instead of throwing "not mocked".
        unitTests.isReturnDefaultValues = true
    }

    // feat/transition-engine: the GL transition shaders ship as assets, COPIED from shared/Transitions
    // at build (the single source of truth — same .glsl the web bundle + Tizen build assemble from),
    // so the native compositor can't drift from the other players. See copyTransitionShaders below.
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/transitionAssets"))
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.0.4")
    // AndroidX
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-service:2.7.0")

    // Encrypted SharedPreferences
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // ExoPlayer / Media3
    implementation("androidx.media3:media3-exoplayer:1.2.1")
    implementation("androidx.media3:media3-ui:1.2.1")

    // Socket.IO client.
    //
    // org.json is excluded deliberately. socket.io-client pulls org.json:json:20090211
    // transitively, and that artifact was being packaged into the APK in full — 19 classes,
    // including CDL, XML, JSONML and its own Test class. It carries the JSON License, whose
    // "shall be used for Good, not Evil" clause is not OSI-approved, is treated as non-free by
    // Debian and Fedora, and is Category X at Apache. Shipping it in a commercially distributed
    // binary is an avoidable licensing problem: it is not copyleft, but it is not a licence we
    // want to have to explain.
    //
    // Nothing is lost. Android provides org.json in the platform (since API 1, and minSdk is 24),
    // and the only classes either side actually touches are JSONObject, JSONArray and JSONTokener.
    // The full method surface used — by socket.io/engine.io and by our own Kotlin — is
    // get/getString/getLong/getJSONArray/getJSONObject/has/keys/length/isNull/put/NULL,
    // the opt* family, and JSONTokener.nextValue. Every one is platform API.
    implementation("io.socket:socket.io-client:2.1.0") {
        exclude(group = "org.json", module = "json")
    }

    // WorkManager for background downloads
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // Gson for JSON
    implementation("com.google.code.gson:gson:2.10.1")

    // OkHttp for file downloads
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // #go2rtc — WebRTC for the Android live-video publisher (MediaProjection -> WebRTC sender).
    // stream-webrtc-android is the maintained successor to the abandoned org.webrtc:google-webrtc,
    // and ships the same org.webrtc.* API (PeerConnectionFactory, ScreenCapturerAndroid, ...).
    implementation("io.getstream:stream-webrtc-android:1.3.10")

    // #74/#75: unit tests for the Kotlin schedule evaluator (vector drift guard)
    testImplementation("junit:junit:4.13.2")
    // feat/transition-engine: real org.json on the unit-test classpath (the stubbed android.jar one
    // returns defaults with isReturnDefaultValues=true) so TransitionParseTest exercises actual parsing.
    testImplementation("org.json:json:20231013")
}

// feat/transition-engine: copy the shared GL transition shaders into a generated assets dir so the
// native compositor loads the SAME .glsl the web/Tizen players do (no checked-in copy to drift). Wired
// ahead of asset merge for every variant.
val copyTransitionShaders by tasks.registering(Copy::class) {
    from(File(rootProject.projectDir.parentFile, "shared/Transitions")) { include("*.glsl") }
    into(layout.buildDirectory.dir("generated/transitionAssets/transitions"))
}
tasks.matching { it.name == "preBuild" || it.name.startsWith("merge") && it.name.endsWith("Assets") }
    .configureEach { dependsOn(copyTransitionShaders) }

// #74/#75: point the evaluator drift-guard test at the SHARED vector contract
// (shared/schedule-vectors.json, the single source - no snapshot). rootProject is
// the android/ Gradle root; its parent is the repo root. Any ScheduleEval.kt edit
// that breaks a vector fails ScheduleEvalTest in CI.
tasks.withType<Test> {
    systemProperty("scheduleVectors", File(rootProject.projectDir.parentFile, "shared/schedule-vectors.json").absolutePath)
    // Same mechanism for the trigger fire path. ⚠️ That one decides whether an unauthenticated LAN
    // packet changes what is on a screen, and it has two implementations in two languages — so the
    // shared vectors are the contract and TriggerResolveTest holds this one to it.
    systemProperty("triggerVectors", File(rootProject.projectDir.parentFile, "shared/trigger-vectors.json").absolutePath)
}

// #81: AGP ignores enableV1Signing at minSdk>=24, so `assembleRelease` produces a
// v2-only APK - and some MDM-managed signage (MAXHUB/Pivot) silently removes a v2-only
// app on the next reboot because its boot integrity check expects a v1 (JAR) signature.
// Re-sign the assembled release APK with apksigner, forcing a low --min-sdk-version so
// the v1 signature is emitted alongside v2/v3. v1+v2+v3 verifies on every Android
// version (legacy MDM hardware via v1, modern Android via v2/v3).
tasks.register<Exec>("resignReleaseV1") {
    val apk = layout.buildDirectory.file("outputs/apk/release/app-release.apk").get().asFile
    onlyIf { apk.exists() }
    doFirst {
        val sdkDir = System.getenv("ANDROID_HOME")
            ?: System.getenv("ANDROID_SDK_ROOT")
            ?: rootProject.file("local.properties").takeIf { it.exists() }
                ?.readLines()?.firstOrNull { it.startsWith("sdk.dir=") }?.substringAfter("=")?.trim()
            ?: throw GradleException("#81 resign: set ANDROID_HOME or sdk.dir in local.properties")
        val buildTools = File(sdkDir, "build-tools").listFiles()
            ?.filter { it.isDirectory }?.maxByOrNull { it.name }
            ?: throw GradleException("#81 resign: no build-tools found under $sdkDir")
        commandLine(
            File(buildTools, "apksigner").absolutePath, "sign",
            "--ks", file("../release-key.jks").absolutePath,
            "--ks-key-alias", (System.getenv("KEY_ALIAS") ?: "remotedisplay"),
            "--ks-pass", "pass:" + (System.getenv("KEYSTORE_PASSWORD") ?: ""),
            "--key-pass", "pass:" + (System.getenv("KEY_PASSWORD") ?: ""),
            "--v1-signing-enabled", "true",
            "--v2-signing-enabled", "true",
            "--v3-signing-enabled", "true",
            "--min-sdk-version", "19",
            apk.absolutePath
        )
    }
}
// AGP registers assembleRelease lazily, so match it when/after it's created.
tasks.matching { it.name == "assembleRelease" }.configureEach { finalizedBy("resignReleaseV1") }
