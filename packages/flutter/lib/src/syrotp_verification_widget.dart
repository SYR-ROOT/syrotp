import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import 'sms_intent.dart';
import 'verification.dart';
import 'verification_controller.dart';
import 'verification_status.dart';

const String _kDefaultInstruction = 'Send this SMS to verify your phone.';

/// Flutter widget rendering the SYROTP verification flow.
///
/// Same wire contract and lifecycle as `@syrotp/react`,
/// `@syrotp/web-component`, and `syrotp-android-ui`: the developer's
/// backend creates the verification (secret-keyed), forwards the
/// result, and the widget polls the public `/v/:id/status` endpoint
/// and fires the appropriate callback on each transition out of
/// `pending`.
///
/// Multi-platform: Android, iOS, web, macOS, Linux, Windows. The
/// SMS link uses `url_launcher`, and the clipboard uses Flutter's
/// `Clipboard.setData` — both work everywhere.
class SyrotpVerificationWidget extends StatefulWidget {
  final Verification verification;
  final String baseUrl;
  final Duration pollInterval;
  final String initialInstruction;
  final void Function(Verification)? onVerified;
  final void Function(Verification)? onExpired;
  final void Function(Verification)? onCancelled;
  final void Function(Object)? onError;

  /// HTTP client used for status polling. Optional — primarily a
  /// test seam. The widget creates its own internally if null and
  /// closes it on dispose.
  final http.Client? httpClient;

  const SyrotpVerificationWidget({
    super.key,
    required this.verification,
    required this.baseUrl,
    this.pollInterval = const Duration(milliseconds: 2500),
    this.initialInstruction = _kDefaultInstruction,
    this.onVerified,
    this.onExpired,
    this.onCancelled,
    this.onError,
    this.httpClient,
  });

  @override
  State<SyrotpVerificationWidget> createState() =>
      _SyrotpVerificationWidgetState();
}

class _SyrotpVerificationWidgetState extends State<SyrotpVerificationWidget> {
  late VerificationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = _buildController();
    _controller.start();
  }

  @override
  void didUpdateWidget(covariant SyrotpVerificationWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    // If the consumer hands us a brand-new verification (different
    // id), tear down and rebuild — same semantics as remounting.
    if (widget.verification.id != oldWidget.verification.id) {
      _controller.dispose();
      _controller = _buildController();
      _controller.start();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  VerificationController _buildController() {
    return VerificationController(
      baseUrl: widget.baseUrl,
      initial: widget.verification,
      pollInterval: widget.pollInterval,
      httpClient: widget.httpClient,
      onVerified: widget.onVerified,
      onExpired: widget.onExpired,
      onCancelled: widget.onCancelled,
      onError: widget.onError,
    );
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<VerificationState>(
      valueListenable: _controller,
      builder: (context, state, _) => _renderState(context, state),
    );
  }

  Widget _renderState(BuildContext context, VerificationState state) {
    final v = state.verification;
    if (v.status == VerificationStatus.pending &&
        v.sendTo != null &&
        v.message != null) {
      return _PendingContent(
        instruction: widget.initialInstruction,
        verification: v,
        secondsLeft: state.secondsLeft,
        onCopy: () => _copy(v.message!),
        onOpenSms: () => _openSms(v.sendTo!, v.message!),
      );
    }
    return switch (v.status) {
      VerificationStatus.verified =>
        const _StatusBlock(text: 'Phone verified.'),
      VerificationStatus.expired => const _StatusBlock(
          text: 'Verification expired. Start a new one to continue.',
        ),
      VerificationStatus.cancelled =>
        const _StatusBlock(text: 'Verification cancelled.'),
      VerificationStatus.failed =>
        const _StatusBlock(text: 'Verification failed.'),
      VerificationStatus.pending => const SizedBox.shrink(),
    };
  }

  Future<void> _copy(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger?.showSnackBar(
      const SnackBar(content: Text('Copied'), duration: Duration(seconds: 1)),
    );
  }

  Future<void> _openSms(String recipient, String body) async {
    final uri = SmsIntent.buildSmsUri(recipient, body);
    try {
      final ok = await launchUrl(uri);
      if (!ok && mounted) {
        final messenger = ScaffoldMessenger.maybeOf(context);
        messenger?.showSnackBar(
          const SnackBar(content: Text('No SMS app available')),
        );
      }
    } catch (e) {
      widget.onError?.call(e);
    }
  }
}

class _PendingContent extends StatelessWidget {
  final String instruction;
  final Verification verification;
  final int secondsLeft;
  final VoidCallback onCopy;
  final VoidCallback onOpenSms;

  const _PendingContent({
    required this.instruction,
    required this.verification,
    required this.secondsLeft,
    required this.onCopy,
    required this.onOpenSms,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(instruction, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 8),
          Text(
            'From: ${verification.phoneMasked}',
            style: theme.textTheme.bodySmall,
          ),
          const SizedBox(height: 4),
          Text('To: ${verification.sendTo!}', style: theme.textTheme.bodyMedium),
          const SizedBox(height: 8),
          SelectableText(
            verification.message!,
            style: const TextStyle(
              fontFamily: 'monospace',
              fontSize: 18,
              fontWeight: FontWeight.w500,
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            children: [
              ElevatedButton(onPressed: onCopy, child: const Text('Copy')),
              OutlinedButton(
                onPressed: onOpenSms,
                child: const Text('Open SMS app'),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'Expires in ${_format(secondsLeft)}',
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }

  String _format(int secs) {
    final m = secs ~/ 60;
    final s = secs % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }
}

class _StatusBlock extends StatelessWidget {
  final String text;
  const _StatusBlock({required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Text(text, style: Theme.of(context).textTheme.bodyLarge),
    );
  }
}
