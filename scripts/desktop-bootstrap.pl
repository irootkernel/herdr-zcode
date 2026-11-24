use strict;
use warnings;
use Cwd qw(getcwd);
use Encode qw(decode);
use Errno qw(ENOENT);
use JSON::PP qw(decode_json encode_json);
use POSIX qw(setsid _exit);

my %messages = (
    invalid_arguments => 'Use --check-desktop --json with an optional --app-bundle path.',
    app_bundle_missing => 'ZCode Desktop bundle is missing.',
    app_bundle_invalid => 'ZCode Desktop bundle has missing or invalid required metadata or files.',
    app_version_below_minimum => 'ZCode Desktop version is below the required minimum.',
    embedded_runtime_invalid => 'ZCode Desktop embedded runtime is unavailable or incompatible.',
);

# Capture only a bounded command result. Keep the bootstrap and any embedded
# probe it starts in a separate process group so a timeout cannot leak output.
sub capture {
    my ($timeout, @command) = @_;
    pipe(my $reader, my $writer) or return;
    my $pid = fork();
    return unless defined $pid;
    if ($pid == 0) {
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
        local $SIG{INT} = local $SIG{TERM} = local $SIG{HUP} = sub { die "command interrupted\n" };
        alarm $timeout;
        while (1) {
            my $size = sysread($reader, my $chunk, 4096);
            die "command read failed\n" unless defined $size;
            last if $size == 0;
            $output .= $chunk;
            die "command produced too much output\n" if length($output) > 65536;
        }
        waitpid($pid, 0) == $pid or die "command wait failed\n";
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
    my ($plist, $field) = @_;
    return unless -f $plist;
    my ($status, $value) = capture(2, '/usr/bin/plutil', '-extract', $field, 'raw', '-expect', 'string', '-o', '-', $plist);
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

my ($root, @args) = @ARGV;
my $bundle = $ENV{HERDR_ZCODE_APP_BUNDLE} // '';
$bundle = '/Applications/ZCode.app' unless length $bundle;
my ($check, $json, $bundle_arg, $invalid) = (0, 0, 0, 0);
for (my $index = 0; $index < @args; $index++) {
    my $arg = $args[$index];
    if ($arg eq '--check-desktop' && !$check) { $check = 1; }
    elsif ($arg eq '--json' && !$json) { $json = 1; }
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
my $app = plist_string($plist, 'CFBundleShortVersionString');
$app = undef if defined $app && $app !~ /\A[0-9]+\.[0-9]+\.[0-9]+\z/;
sub fail {
    my ($reason) = @_;
    print encode_json({ compatible => JSON::PP::false, reason => $reason, message => $messages{$reason},
        appVersion => $app, minZcodeAppVersion => $minimum, appBundle => decode('UTF-8', $bundle) }), "\n";
    exit 1;
}

fail('invalid_arguments') if $invalid || !$check || !$json;
my @bundle_metadata = stat $bundle;
fail($! == ENOENT ? 'app_bundle_missing' : 'app_bundle_invalid') unless @bundle_metadata;
my $build = plist_string($plist, 'CFBundleVersion');
my $executable = "$bundle/Contents/MacOS/ZCode";
my $launcher = "$bundle/Contents/Resources/glm/zcode.cjs";
my $catalog = "$bundle/Contents/Resources/config/provider/zcode-builtin.json";
fail('app_bundle_invalid') unless -d $bundle && defined $app && defined $build && $build ne '' &&
    -f $executable && -x $executable && -s $executable && -f $launcher && -r $launcher && -s $launcher &&
    -f $catalog && -r $catalog && -s $catalog && -s $catalog <= 4 * 1024 * 1024;

delete @ENV{qw(NODE_OPTIONS NODE_PATH)};
my $node = $executable;
my $nvm = $ENV{NVM_DIR} || ($ENV{HOME} ? "$ENV{HOME}/.nvm" : '');
if ($nvm && defined $versions{NODE_VERSION}) {
    my $pinned = "$nvm/versions/node/v$versions{NODE_VERSION}/bin/node";
    $node = $pinned if -f $pinned && -x $pinned;
}
if ($node eq $executable) { $ENV{ELECTRON_RUN_AS_NODE} = 1; }
else { delete $ENV{ELECTRON_RUN_AS_NODE}; }

my ($status, $output) = capture(12, $node, "$root/bin/herdr-zcode-app.mjs", @args);
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
