use strict;
use warnings;
use Cwd qw(getcwd);
use Encode qw(decode);
use Errno qw(EINTR ENOENT);
use JSON::PP qw(decode_json encode_json);
use POSIX qw(setsid _exit sigprocmask SIG_BLOCK SIG_SETMASK SIGINT SIGTERM SIGHUP WIFSIGNALED WTERMSIG);
use Time::HiRes qw(alarm clock_gettime CLOCK_MONOTONIC_RAW);

my %messages = (
    invalid_arguments => 'Use --check-desktop --json with an optional --app-bundle path.',
    app_bundle_missing => 'ZCode Desktop bundle is missing.',
    app_bundle_invalid => 'ZCode Desktop bundle has missing or invalid required metadata or files.',
    app_version_below_minimum => 'ZCode Desktop version is below the required minimum.',
    embedded_runtime_invalid => 'ZCode Desktop embedded runtime is unavailable or incompatible.',
);
my %prepare_messages = (
    invalid_arguments => 'Use prepare-isolated --out-dir <path> with optional --app-bundle and --json.',
    output_dir_invalid => 'Use an existing private output directory owned by the invoking user.',
    output_exists => 'One or more prepared input files already exist.',
    desktop_account_unavailable => 'The Z.AI Coding Plan account could not be read.',
    desktop_keychain_unavailable => 'The ZCode Desktop Keychain credential could not be read.',
    catalog_invalid => 'The bundled provider catalog is invalid or incompatible.',
    preparation_timeout => 'Input preparation reached its time limit.',
    preparation_interrupted => 'Input preparation was interrupted.',
    projection_failed => 'Could not write or clean up the prepared inputs.',
);
my ($caught_signal, $forward_signals, $prepare);
my %interrupt_names = (SIGINT() => 'INT', SIGTERM() => 'TERM', SIGHUP() => 'HUP');

# Capture only a bounded command result. Keep the bootstrap and any embedded
# probe it starts in a separate process group so a timeout cannot leak output.
sub capture {
    my ($timeout, @command) = @_;
    return if $timeout <= 0 || ($prepare && $caught_signal);
    pipe(my $reader, my $writer) or return;
    my $original_mask;
    if ($prepare) {
        $original_mask = POSIX::SigSet->new;
        # Keep a forwarded interrupt pending until the child installs its
        # default dispositions. Perl's inherited handlers would swallow it.
        sigprocmask(SIG_BLOCK, POSIX::SigSet->new(keys %interrupt_names), $original_mask) or return;
    }
    my $pid = fork();
    if (!defined $pid) {
        sigprocmask(SIG_SETMASK, $original_mask) if $prepare;
        return;
    }
    if ($pid == 0) {
        if ($prepare) {
            $SIG{INT} = $SIG{TERM} = $SIG{HUP} = 'DEFAULT';
            _exit(1) if $caught_signal;
            sigprocmask(SIG_SETMASK, $original_mask) or _exit(1);
        }
        close $reader;
        setsid() >= 0 or _exit(1);
        open(STDIN, '<', '/dev/null') or _exit(1);
        open(STDERR, '>', '/dev/null') or _exit(1);
        open(STDOUT, '>&', $writer) or _exit(1);
        close $writer;
        exec { $command[0] } @command or _exit(1);
    }
    close $writer;
    my ($output, $status) = ('', undef);
    my $completed = eval {
        local $SIG{ALRM} = sub { die "command timeout\n" };
        my $interrupt = sub {
            my ($signal) = @_;
            $caught_signal ||= $signal;
            if ($forward_signals) { kill $signal, $pid; }
            else { die "command interrupted\n"; }
        };
        local $SIG{INT} = sub { $interrupt->('INT'); };
        local $SIG{TERM} = sub { $interrupt->('TERM'); };
        local $SIG{HUP} = sub { $interrupt->('HUP'); };
        alarm $timeout;
        if ($prepare) {
            sigprocmask(SIG_SETMASK, $original_mask) or die "could not restore interrupt mask\n";
        }
        $interrupt->($caught_signal) if $prepare && $caught_signal;
        while (1) {
            my $size = sysread($reader, my $chunk, 4096);
            next if !defined $size && $! == EINTR;
            die "command read failed\n" unless defined $size;
            last if $size == 0;
            $output .= $chunk;
            die "command produced too much output\n" if length($output) > 65536;
        }
        my $waited;
        do { $waited = waitpid($pid, 0); } while ($waited < 0 && $! == EINTR);
        $waited == $pid or die "command wait failed\n";
        $status = $?;
        alarm 0;
        1;
    };
    alarm 0;
    close $reader;
    if (!$completed) {
        kill 'KILL', -$pid, $pid;
        waitpid($pid, 0);
        return;
    }
    if ($prepare && WIFSIGNALED($status)) {
        $caught_signal ||= $interrupt_names{WTERMSIG($status)};
    }
    return ($status, $output);
}

sub absolute_path {
    my ($path) = @_;
    $path = getcwd() . '/' . $path unless $path =~ m{\A/};
    my @components;
    for my $part (split '/', $path) {
        next if $part eq '' || $part eq '.';
        if ($part eq '..') { pop @components; }
        else { push @components, $part; }
    }
    return '/' . join('/', @components);
}

sub plist_string {
    my ($plist, $field, $timeout) = @_;
    return unless -f $plist;
    my ($status, $value) = capture($timeout, '/usr/bin/plutil', '-extract', $field, 'raw', '-expect', 'string', '-o', '-', $plist);
    return unless defined $status && $status == 0;
    $value =~ s/\A\s+|\s+\z//g;
    return $value;
}

sub version_below {
    my ($app, $minimum) = @_;
    my @actual = split /\./, $app;
    my @required = split /\./, $minimum;
    for my $index (0 .. 2) {
        for ($actual[$index], $required[$index]) { s/\A0+(?=\d)//; }
        my $order = (length($actual[$index]) <=> length($required[$index])) || ($actual[$index] cmp $required[$index]);
        return $order < 0 if $order;
    }
    return 0;
}

# JSON::PP preserves the decoded number/string distinction when re-encoding an
# uncoerced scalar. Perl string comparisons alone would accept JSON numbers.
sub json_string {
    my ($value) = @_;
    return defined $value && !ref($value) && encode_json([$value]) =~ /\A\["/;
}

my ($root, $started_ms, @args) = @ARGV;
$prepare = $args[0] eq 'prepare-isolated';
if ($prepare) {
    $SIG{INT} = sub { $caught_signal ||= 'INT'; };
    $SIG{TERM} = sub { $caught_signal ||= 'TERM'; };
    $SIG{HUP} = sub { $caught_signal ||= 'HUP'; };
}
my $work_until = $prepare ? $started_ms / 1000 + 10 : undef;
my $finish_by = $prepare ? $started_ms / 1000 + 12 : undef;
sub preparation_time { return clock_gettime(CLOCK_MONOTONIC_RAW); }
sub plist_timeout {
    return 2 unless $prepare;
    my $remaining = $work_until - preparation_time();
    return $remaining < 2 ? $remaining : 2;
}

my $bundle = $ENV{HERDR_ZCODE_APP_BUNDLE} // '';
$bundle = '/Applications/ZCode.app' if $prepare || !length $bundle;
my ($check, $json, $bundle_arg, $invalid, $out_dir) = (0, 0, 0, 0, 0);
for (my $index = $prepare ? 1 : 0; $index < @args; $index++) {
    my $arg = $args[$index];
    if (!$prepare && $arg eq '--check-desktop' && !$check) { $check = 1; }
    elsif ($arg eq '--json' && !$json) { $json = 1; }
    elsif ($prepare && $arg eq '--out-dir' && !$out_dir && defined $args[$index + 1] &&
        $args[$index + 1] ne '' && $args[$index + 1] !~ /\A--/) { $out_dir = 1; $index++; }
    elsif ($arg eq '--app-bundle' && defined $args[$index + 1] && $args[$index + 1] ne '' && $args[$index + 1] !~ /\A--/) {
        $bundle = $args[++$index];
        $invalid ||= $bundle_arg;
        $bundle_arg = 1;
    } else { $invalid = 1; }
}
$bundle = absolute_path($bundle);

my (%versions, %seen);
if (-f "$root/toolchains.env" && open(my $pins, '<', "$root/toolchains.env")) {
    while (my $line = <$pins>) {
        chomp $line;
        next unless $line =~ /\A(NODE_VERSION|ZCODE_APP_MIN_VERSION)=(.*)\z/;
        my ($key, $value) = ($1, $2);
        if ($seen{$key}++ == 0 && $value =~ /\A[0-9]+\.[0-9]+\.[0-9]+\z/) { $versions{$key} = $value; }
        else { delete $versions{$key}; }
    }
}
my $minimum = $versions{ZCODE_APP_MIN_VERSION};
my $plist = "$bundle/Contents/Info.plist";
my $app;
sub fail {
    my ($reason) = @_;
    if ($prepare) {
        print encode_json({ reason => $reason, message => $prepare_messages{$reason} // $messages{$reason} }), "\n";
    } else {
        print encode_json({ compatible => JSON::PP::false, reason => $reason, message => $messages{$reason},
            appVersion => $app, minZcodeAppVersion => $minimum, appBundle => decode('UTF-8', $bundle) }), "\n";
    }
    exit 1;
}

fail('invalid_arguments') if $prepare && ($invalid || !$out_dir);
sub check_preparation_time {
    return unless $prepare;
    fail('preparation_interrupted') if $caught_signal;
    fail('preparation_timeout') if preparation_time() >= $work_until;
}
check_preparation_time();
$app = plist_string($plist, 'CFBundleShortVersionString', plist_timeout());
$app = undef if defined $app && $app !~ /\A[0-9]+\.[0-9]+\.[0-9]+\z/;
check_preparation_time();
fail('invalid_arguments') if !$prepare && ($invalid || !$check || !$json);
my @bundle_metadata = stat $bundle;
fail($! == ENOENT ? 'app_bundle_missing' : 'app_bundle_invalid') unless @bundle_metadata;
my $build = plist_string($plist, 'CFBundleVersion', plist_timeout());
check_preparation_time();
my $executable = "$bundle/Contents/MacOS/ZCode";
my $launcher = "$bundle/Contents/Resources/glm/zcode.cjs";
my $catalog = "$bundle/Contents/Resources/config/provider/zcode-builtin.json";
fail('app_bundle_invalid') unless -d $bundle && defined $app && defined $build && $build ne '' &&
    -f $executable && -x $executable && -s $executable && -f $launcher && -r $launcher && -s $launcher;
fail($prepare ? 'catalog_invalid' : 'app_bundle_invalid') unless -f $catalog && -r $catalog && -s $catalog && -s $catalog <= 4 * 1024 * 1024;

delete @ENV{qw(NODE_OPTIONS NODE_PATH)};
my $node = $executable;
my $nvm = $ENV{NVM_DIR} || ($ENV{HOME} ? "$ENV{HOME}/.nvm" : '');
if (!$prepare && $nvm && defined $versions{NODE_VERSION}) {
    my $pinned = "$nvm/versions/node/v$versions{NODE_VERSION}/bin/node";
    $node = $pinned if -f $pinned && -x $pinned;
}
if ($node eq $executable) { $ENV{ELECTRON_RUN_AS_NODE} = 1; }
else { delete $ENV{ELECTRON_RUN_AS_NODE}; }

check_preparation_time();
$ENV{HERDR_ZCODE_PREPARE_STARTED_MS} = $started_ms if $prepare;
$forward_signals = $prepare;
my ($status, $output) = capture($prepare ? $finish_by - preparation_time() : 12, $node, "$root/bin/herdr-zcode-app.mjs", @args);
if ($prepare) {
    my $result = defined $status && $output =~ /\A[^\n]+\n\z/ ? eval { decode_json($output) } : undef;
    if (ref($result) eq 'HASH') {
        my @text = qw(authFile catalogFile catalogSHA256 catalogSource appVersion minZcodeAppVersion providerId accountIdentitySHA256);
        my $revision = $result->{catalogRevision};
        if ($status == 0 && keys(%$result) == @text + 1 && !grep(!json_string($result->{$_}), @text)) {
            if (defined $revision && !ref($revision) && encode_json([$revision]) =~ /\A\[[1-9][0-9]*\]\z/ &&
                $result->{authFile} =~ m{\A/} && $result->{catalogFile} =~ m{\A/} &&
                $result->{catalogSource} =~ /\A(?:desktop-cache|bundled)\z/ && $result->{appVersion} eq $app &&
                defined $minimum && $result->{minZcodeAppVersion} eq $minimum &&
                $result->{catalogSHA256} =~ /\A[0-9a-f]{64}\z/ && $result->{accountIdentitySHA256} =~ /\A[0-9a-f]{64}\z/) {
                print encode_json({ map { $_ => $result->{$_} } @text, 'catalogRevision' }), "\n";
                exit 0;
            }
        }
        if ($status == 256 && keys(%$result) == 2 && json_string($result->{reason}) && json_string($result->{message})) {
            my $reason = $result->{reason};
            my $message = $prepare_messages{$reason} // $messages{$reason};
            fail($reason) if defined $message && $message eq $result->{message};
        }
    }
    check_preparation_time();
    fail('app_version_below_minimum') if defined $minimum && version_below($app, $minimum);
    fail('embedded_runtime_invalid');
}
if (defined $status && ($status == 0 || $status == 256) && $output =~ /\A[^\n]+\n\z/) {
    my $result = eval { decode_json($output) };
    if (ref($result) eq 'HASH' && JSON::PP::is_bool($result->{compatible}) &&
        json_string($result->{appBundle}) && $result->{appBundle} eq decode('UTF-8', $bundle) &&
        json_string($result->{appVersion}) && $result->{appVersion} eq $app &&
        (defined $minimum ? json_string($result->{minZcodeAppVersion}) && $result->{minZcodeAppVersion} eq $minimum
            : exists $result->{minZcodeAppVersion} && !defined $result->{minZcodeAppVersion})) {
        my @success_fields = qw(compatible appVersion build minZcodeAppVersion appBundle nodeVersion electronVersion);
        if ($status == 0 && $result->{compatible} && keys(%$result) == @success_fields &&
            defined $minimum && !version_below($app, $minimum) &&
            json_string($result->{build}) && $result->{build} eq decode('UTF-8', $build) &&
            json_string($result->{electronVersion}) && $result->{electronVersion} =~ /[^\s\x{FEFF}]/ &&
            json_string($result->{nodeVersion}) && $result->{nodeVersion} =~ /\A[0-9]+\.[0-9]+\.[0-9]+\z/ &&
            !version_below($result->{nodeVersion}, '20.0.0')) {
            print encode_json({ map { $_ => $result->{$_} } @success_fields }), "\n";
            exit 0;
        }
        if ($status == 256 && !$result->{compatible} && keys(%$result) == 6 &&
            json_string($result->{reason}) && exists $messages{$result->{reason}} &&
            json_string($result->{message}) && $result->{message} eq $messages{$result->{reason}}) {
            fail($result->{reason});
        }
    }
}
fail('app_version_below_minimum') if defined $minimum && version_below($app, $minimum);
fail('embedded_runtime_invalid');
