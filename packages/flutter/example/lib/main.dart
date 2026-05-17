import 'package:flutter/material.dart';
import 'package:syrotp_flutter/syrotp_flutter.dart';

void main() => runApp(const _DemoApp());

class _DemoApp extends StatelessWidget {
  const _DemoApp();

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SYROTP Flutter Demo',
      theme: ThemeData(useMaterial3: true),
      home: const _DemoScreen(),
    );
  }
}

class _DemoScreen extends StatelessWidget {
  const _DemoScreen();

  @override
  Widget build(BuildContext context) {
    final demo = Verification(
      id: 'vrf_demo000000000',
      status: VerificationStatus.pending,
      sendTo: '+963998887777',
      message: 'VERIFY 123456',
      phoneMasked: '+963 99* *** *567',
      expiresAt: DateTime.now().add(const Duration(minutes: 5)),
    );

    return Scaffold(
      appBar: AppBar(title: const Text('SYROTP — Flutter demo')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'In production your backend calls startVerification() via the secret SDK and forwards the result to your app. This demo uses a hardcoded verification so you can see the UI; status polling is a no-op against the demo baseUrl unless you also have an SYROTP server reachable from this device.',
            ),
            const SizedBox(height: 16),
            SyrotpVerificationWidget(
              verification: demo,
              baseUrl: 'http://localhost:3000',
              onVerified: (v) => debugPrint('verified: ${v.id}'),
              onExpired: (v) => debugPrint('expired: ${v.id}'),
              onCancelled: (v) => debugPrint('cancelled: ${v.id}'),
              onError: (e) => debugPrint('syrotp error: $e'),
            ),
          ],
        ),
      ),
    );
  }
}
